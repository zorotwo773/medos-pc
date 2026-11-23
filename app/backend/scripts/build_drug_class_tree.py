"""Build a hierarchical medication-class tree into drug_reference.sqlite.

The drug reference ships ~1,144 flat, granular class labels (one messy string
per drug: "Analgesic Anti-Inflammatory NSAID ..."). This importer replaces the
flat browse with a clean 2-level therapeutic hierarchy modelled on how a
professional drug reference (epocrates) arranges its formulary:

    Therapeutic area   (22 clean roots: Cardiovascular, Infectious Disease, …)
      └─ Subclass      (ACE Inhibitors, Statins, Beta Blockers, …)
           └─ drugs

Every one of the 2,663 drugs is placed under exactly one area (>=1 subclass),
using a 3-tier source priority so coverage is 100%:

  1. EPOCRATES  — the drug matches an epocrates drug that carries a class in
                  DRUG_TO_DRUG_CLASS; use its epocrates subclass(es) and their
                  parent therapeutic area. Cleanest, ~950 drugs.
  2. ATC        — no epocrates class, but the drug has a WHO ATC code; map the
                  ATC anatomical letter (A/C/J/L/N…) to a therapeutic area, and
                  use the cleaned legacy label as the subclass name.
  3. LEGACY     — neither; keyword-map the legacy drug_class string to an area
                  (else "Other Agents"); subclass = cleaned legacy label.

Tables written (idempotent — dropped and rebuilt each run):
    drug_class_nodes(id, parent_id, name, level, source, sort_key)
    drug_class_membership(drug_id, node_id, is_primary, source)

Usage:  python scripts/build_drug_class_tree.py [--dry-run]
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import DRUG_REF_DB, ROOT  # noqa: E402
from build_epocrates_dosing import _norm, _base, _combo_key  # noqa: E402

OTHER_AREA = "Other Agents"

# ── ATC anatomical/therapeutic letter → therapeutic area ─────────────────────
# Keyed on the ATC code prefix (longest prefix wins), values are epocrates area
# names so ATC-placed drugs land in the same 22-area tree.
_ATC_AREA = [
    # A — alimentary tract & metabolism (precise, not a blanket "A"→GI)
    ("A01", "Dental/Oral Care"),               # stomatological
    ("A08", "Endocrine/Metabolism"),           # antiobesity
    ("A10", "Endocrine/Metabolism"),           # diabetes
    ("A11", "Nutrition/Electrolytes"),         # vitamins
    ("A12", "Nutrition/Electrolytes"),         # minerals
    ("A13", "Nutrition/Electrolytes"),         # tonics
    ("A14", "Endocrine/Metabolism"),           # anabolic agents
    ("A15", "Nutrition/Electrolytes"),         # appetite stimulants
    ("A16", "Endocrine/Metabolism"),           # other metabolism (enzyme replacement)
    ("A", "Gastrointestinal"),                 # A02-A09 acid/GI motility
    ("B", "Hematology/Oncology"),               # blood / anticoagulants
    ("C05", None),                              # vasoprotectives (hemorrhoid/varicose) → defer to legacy
    ("C", "Cardiovascular"),
    ("D", "Dermatologic"),
    ("G04", "Nephrology/Urology"),
    ("G", "Obstetrics/Gynecology"),             # sex hormones / GU
    ("H", "Endocrine/Metabolism"),              # systemic hormones
    ("J07", "Immunizations"),
    ("J06", "Immunology"),                       # immune sera / immunoglobulins
    ("J", "Infectious Disease"),
    ("L01", "Hematology/Oncology"),             # antineoplastics
    ("L02", "Hematology/Oncology"),             # endocrine oncology therapy
    ("L03", "Immunology"),                       # immunostimulants
    ("L04", "Immunology"),                      # immunosuppressants
    ("L", "Hematology/Oncology"),
    ("M", "Rheumatologic"),
    ("N05", "Psychiatric"),
    ("N06", "Psychiatric"),
    ("N", "Neurologic"),
    ("P", "Infectious Disease"),
    ("R01", "Allergy/Cold/ENT"),
    ("R06", "Allergy/Cold/ENT"),
    ("R", "Asthma/Pulmonary"),
    ("S01", "Ophthalmic"),
    ("S", "Ophthalmic"),
    ("V", "Diagnostic"),
]


def area_from_atc(code: str) -> str | None:
    code = (code or "").upper()
    for prefix, area in _ATC_AREA:
        if code.startswith(prefix):
            return area
    return None


# ── legacy label keyword → area (ordered; first hit wins) ────────────────────
# Order matters: the most specific / least-ambiguous patterns are checked first
# so a "Laxative, Stimulant" combo does not match Psychiatric's "stimulant",
# and a lysosomal-storage enzyme replacement does not match GI's "gastrointestinal".
_LEGACY_AREA = [
    # metabolic enzyme replacement / lysosomal storage (must beat GI + Heme)
    (r"lysosomal|gaucher|fabry|pompe|mucopolysacchar|niemann|"
     r"enzyme replacement|glucosylceramide|galactosidase|glucocerebrosidase|"
     r"alpha-glucosidase|sphingomyelinase|inborn error", "Endocrine/Metabolism"),
    # uterotonics / ergot uterine agents (must beat Endocrine's "pituitary")
    (r"oxytocic|uterotonic|uterine|ergonovine|ergometrine|methylergonovine|"
     r"tocolytic|abortifacient", "Obstetrics/Gynecology"),
    # oncology — deliberately NOT bare "monoclonal" (many mAbs are immunology,
    # e.g. infliximab/adalimumab), require an oncology-specific token
    (r"antineoplas|chemotherap|antitumor|antimetabolite|alkylating|topoisomerase|"
     r"tyrosine kinase inhibitor|kinase inhibitor|antiandrogen|aromatase|"
     r"antiestrogen|erythropoiesis|anticoagul|thrombolytic|"
     r"antiplatelet|antihemophilic|coagulation|hemostatic|antianemi|"
     r"colony stimulating|hematopoietic", "Hematology/Oncology"),
    (r"antibiotic|antibacterial|antiviral|antifungal|antimalari|antiprotozo|"
     r"anthelmintic|antimycobacter|penicillin|cephalosporin|macrolide|"
     r"quinolone|fluoroquinolone|tetracycline|sulfonamide|aminoglycoside|"
     r"antiretroviral|antitubercul|antiparasit|antimicrob", "Infectious Disease"),
    (r"vaccine|toxoid|immuniz", "Immunizations"),
    (r"immunosuppress|immunomodulat|immunolog|interferon|interleukin|"
     r"tumor necrosis factor|tnf|integrin|interstitial|monoclonal antibod", "Immunology"),
    # Pain BEFORE Cardiovascular/Asthma so an analgesic combo containing caffeine
    # ("Methylxanthine NSAID Opioid …") is filed as an analgesic, not pulmonary.
    (r"analgesic|opioid|\bnsaid\b|nonsteroidal anti|antipyretic|"
     r"local anesthetic|general anesthetic|anesthesia", "Anesthesia/Pain Management"),
    (r"antihypertensive|antiarrhythmic|beta.?blocker|calcium channel|ace inhibitor|"
     r"angiotensin|diuretic|vasodilator|vasopressor|inotrop|antianginal|"
     r"cardiac|antilipemic|statin|hmg.?coa|antihyperlipid|nitrate|digitalis|"
     r"cardiovascular", "Cardiovascular"),
    (r"bronchodilat|beta.?2|asthma|pulmonary|respiratory|leukotriene|"
     r"mucolytic|expectorant|xanthine", "Asthma/Pulmonary"),
    (r"antihistamine|decongestant|antitussive|nasal|otic|rhinitis|allerg", "Allergy/Cold/ENT"),
    (r"antidepress|antipsychot|anxiolytic|benzodiazepine|barbiturate|"
     r"sedative|hypnotic|mood stabil|cns stimulant|psychostimulant|amphetamine|"
     r"methylphenidate|adhd|ssri|snri|maoi|psychotherap|antimanic", "Psychiatric"),
    (r"anticonvuls|antiepileptic|antiparkinson|antimigraine|dopamin|"
     r"cholinesterase|nmda|muscle relaxant|neuromuscular|antivertigo|"
     r"myasthen|multiple sclerosis|alzheim|antispasti", "Neurologic"),
    (r"antidiabetic|insulin|hypoglycem|thyroid|corticosteroid|glucocorticoid|"
     r"androgen|estrogen|progest|growth hormone|somatostatin|pituitary|"
     r"bisphosphonate|calcitonin|endocrine|adrenal|antithyroid", "Endocrine/Metabolism"),
    (r"antacid|proton pump|h2 |histamine.?2|laxative|antidiarrhe|antiemetic|"
     r"antinausea|digestant|prokinetic|antiulcer|gastrointestinal|"
     r"5.?ht3|antispasmodic", "Gastrointestinal"),
    (r"dermatolog|topical|keratolytic|acne|antipsoriatic|emollient|"
     r"antipruritic|sunscreen|scabicide|pediculicide", "Dermatologic"),
    (r"ophthalmic|miotic|mydriatic|intraocular|glaucoma", "Ophthalmic"),
    (r"contracep|oxytocic|tocolytic|uterine|fertility|vaginal|"
     r"obstetric|gyneco", "Obstetrics/Gynecology"),
    (r"urinary|bladder|erectile|prostat|nephro|renal|overactive bladder|"
     r"phosphate binder", "Nephrology/Urology"),
    (r"antirheumatic|antigout|dmard|colchicin|uric", "Rheumatologic"),
    (r"electrolyte|amino acid|parenteral nutrition|vitamin|mineral|"
     r"nutritional|enteral|caloric|dietary", "Nutrition/Electrolytes"),
    (r"diagnostic|contrast|radiopharm|imaging|dye", "Diagnostic"),
    (r"antidote|reversal|chelat|overdose", "Emergency"),
    (r"herbal|homeopath|supplement|alternative", "Alternative Medicines"),
]


def area_from_legacy(label: str) -> str | None:
    low = (label or "").lower()
    for pattern, area in _LEGACY_AREA:
        if re.search(pattern, low):
            return area
    return None


# Lysosomal-storage enzyme-replacement / substrate-reduction agents whose legacy
# labels are unhelpful ("Enzyme Gastrointestinal Agent"); classify by drug name.
_META_ENZYME_RE = re.compile(
    r"\b\w*(?:glucerase|glucosidase|sulfase|galsidase|glucostat|sulfatase)\b|"
    r"\b(sebelipase|glucarpidase|sapropterin|migalastat|miglustat|eliglustat|"
    r"pegvaliase|cerliponase|asfotase|olipudase|velmanase|vestronidase|"
    r"idursulfase|laronidase)\b",
    re.IGNORECASE,
)


def area_from_name(generic: str) -> str | None:
    if _META_ENZYME_RE.search(generic or ""):
        return "Endocrine/Metabolism"
    return None


# ── legacy label cleanup → a readable subclass name ──────────────────────────
_SALT_TAIL = re.compile(
    r"\b(hydrochloride|hcl|sodium|potassium|calcium|sulfate|besylate|mesylate|"
    r"maleate|tartrate|succinate|citrate|phosphate|acetate|fumarate)\b",
    re.IGNORECASE,
)


def clean_legacy_label(raw: str) -> str:
    """The legacy drug_class is several space-joined descriptors; keep a
    readable subclass, salts stripped, truncated on a word boundary (never
    mid-word like '…Factor Inhi')."""
    parts = re.split(r"[|;]", raw or "")
    text = parts[0].strip() if parts else ""
    text = _SALT_TAIL.sub("", text).strip(" ,")
    text = re.sub(r"\s+", " ", text)
    # collapse the "(class)" noise seen in Lexi strings
    text = text.replace("(class)", "").strip()
    if not text:
        return "Unclassified"
    if len(text) <= 54:
        return text
    # cut at the last word boundary at/under 54 chars
    cut = text[:54]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > 20 else cut).strip()


# ── epocrates class tree ─────────────────────────────────────────────────────

def load_epocrates(epo: sqlite3.Connection):
    """Return (class_name, class_area, drug_id -> [class_ids]) for the epocrates
    22-area tree, resolving each subclass to its top therapeutic area."""
    name = {r["ID"]: r["NAME"] for r in epo.execute("SELECT ID, NAME FROM DRUG_CLASS")}

    def ni(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    parents: dict[int, list[int]] = {}
    for r in epo.execute("SELECT PARENT_ID, CHILD_ID FROM DRUG_CLASS_HIERARCHY"):
        p, ch = ni(r["PARENT_ID"]), ni(r["CHILD_ID"])
        if p in name and ch in name and p != ch:
            parents.setdefault(ch, []).append(p)

    roots = [i for i in name if i not in parents]  # the 22 therapeutic areas
    root_set = set(roots)

    def resolve_area(cls_id: int, _seen=None) -> int | None:
        """Climb to the top therapeutic-area root."""
        if cls_id in root_set:
            return cls_id
        _seen = _seen or set()
        if cls_id in _seen:
            return None
        _seen.add(cls_id)
        # sorted() so a subclass with several parent areas resolves the SAME
        # way every build (101 nodes have >1 parent in DRUG_CLASS_HIERARCHY).
        for p in sorted(parents.get(cls_id, [])):
            area = resolve_area(p, _seen)
            if area is not None:
                return area
        return None

    class_area = {cid: resolve_area(cid) for cid in name}

    dtc: dict[int, list[int]] = {}
    for r in epo.execute("SELECT DRUG_ID, DRUG_CLASS_ID FROM DRUG_TO_DRUG_CLASS"):
        d, cl = ni(r["DRUG_ID"]), ni(r["DRUG_CLASS_ID"])
        if d is not None and cl in name and class_area.get(cl):
            dtc.setdefault(d, []).append(cl)

    return name, class_area, dtc, root_set


def build(db_path: Path, epo_path: Path, dry_run: bool) -> None:
    epo = sqlite3.connect(f"file:{epo_path}?mode=ro", uri=True)
    epo.row_factory = sqlite3.Row
    c = sqlite3.connect(str(db_path))
    c.row_factory = sqlite3.Row

    epo_name, epo_class_area, epo_dtc, epo_roots = load_epocrates(epo)

    # epocrates drug-name indexes.  Exact (_norm) maps to ONE epo drug; base
    # (salt-stripped) maps to a bucket but is resolved to a single representative
    # at lookup time.  Critically we NEVER union classes across salt siblings —
    # doing so made plain "Diclofenac" inherit "Diclofenac Potassium"'s
    # migraine class (→ Neurologic), and "Magnesium Sulfate" inherit tocolytic
    # (→ Ob/Gyn) from other magnesium salts.  Route-suffixed epo entries
    # ("gentamicin ophthalmic") are excluded from the systemic indexes so a
    # systemic drug never inherits a topical/ophthalmic class.
    from build_epocrates_dosing import _ROUTE_SUFFIX_RE  # local import: shared guard
    epo_norm_of: dict[int, str] = {}
    epo_exact: dict[str, int] = {}
    epo_base: dict[str, list[int]] = {}
    for d in epo.execute("SELECT ID, NAME FROM DRUG WHERE NAME IS NOT NULL"):
        if not epo_dtc.get(d["ID"]):
            continue
        if _ROUTE_SUFFIX_RE.search(d["NAME"]):
            continue
        nm = _norm(d["NAME"])
        epo_norm_of[d["ID"]] = nm
        if nm and nm not in epo_exact:
            epo_exact[nm] = d["ID"]
        for k in {_base(d["NAME"]), _combo_key(d["NAME"])}:
            if k:
                epo_base.setdefault(k, []).append(d["ID"])

    def resolve_epo(generic: str) -> list[int]:
        """Return the class-ids for ONE representative epocrates drug (never a
        salt-sibling union)."""
        nm = _norm(generic)
        base = _base(generic)
        ck = _combo_key(generic)
        # 1) exact name
        if nm in epo_exact:
            return epo_dtc.get(epo_exact[nm], [])
        # 2) combo / base bucket → pick a single representative
        for key in (ck, base):
            bucket = epo_base.get(key) if key else None
            if not bucket:
                continue
            # prefer the epo drug whose own _norm equals the plain base (the
            # unsalted canonical form); else the lowest id, deterministically.
            rep = next((eid for eid in bucket if epo_norm_of.get(eid) == base), None)
            if rep is None:
                rep = min(bucket)
            return epo_dtc.get(rep, [])
        return []

    # ref drugs + their ATC / legacy fallback data
    ref_drugs = c.execute("SELECT drug_id, generic_name, drug_class FROM drugs").fetchall()
    atc_by_drug: dict[int, str] = {}
    for r in c.execute("SELECT drug_id, atc_code FROM drug_atc ORDER BY id"):
        atc_by_drug.setdefault(int(r["drug_id"]), r["atc_code"])

    # ── schema ──
    c.execute("DROP TABLE IF EXISTS drug_class_membership")
    c.execute("DROP TABLE IF EXISTS drug_class_nodes")
    c.execute("""CREATE TABLE drug_class_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER,
        name TEXT NOT NULL,
        level INTEGER NOT NULL,          -- 0 area, 1 subclass
        source TEXT NOT NULL,
        sort_key TEXT
    )""")
    c.execute("""CREATE TABLE drug_class_membership (
        drug_id INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL
    )""")
    c.execute("CREATE INDEX idx_dcn_parent ON drug_class_nodes(parent_id)")
    c.execute("CREATE INDEX idx_dcm_node ON drug_class_membership(node_id)")
    c.execute("CREATE INDEX idx_dcm_drug ON drug_class_membership(drug_id)")

    # ── node registry (create-or-get) ──
    area_ids: dict[str, int] = {}
    subclass_ids: dict[tuple[int, str], int] = {}

    def get_area(name: str) -> int:
        if name not in area_ids:
            cur = c.execute(
                "INSERT INTO drug_class_nodes (parent_id, name, level, source, sort_key) VALUES (NULL,?,?,?,?)",
                (name, 0, "area", name.lower()),
            )
            area_ids[name] = int(cur.lastrowid)
        return area_ids[name]

    def get_subclass(area_id: int, name: str, source: str) -> int:
        key = (area_id, name.lower())
        if key not in subclass_ids:
            cur = c.execute(
                "INSERT INTO drug_class_nodes (parent_id, name, level, source, sort_key) VALUES (?,?,?,?,?)",
                (area_id, name, 1, source, name.lower()),
            )
            subclass_ids[key] = int(cur.lastrowid)
        return subclass_ids[key]

    # Pre-create the 22 epocrates areas in canonical order so they always exist.
    for rid in sorted(epo_roots, key=lambda x: epo_name[x].lower()):
        get_area(epo_name[rid])

    stats = {"epocrates": 0, "atc": 0, "legacy": 0, "other": 0}
    membership: list[tuple[int, int, int, str]] = []
    seen_pairs: set[tuple[int, int]] = set()

    def place(drug_id: int, area: str, subclass: str, source: str, primary: bool):
        aid = get_area(area)
        sid = get_subclass(aid, subclass, source)
        if (drug_id, sid) in seen_pairs:
            return
        seen_pairs.add((drug_id, sid))
        membership.append((drug_id, sid, 1 if primary else 0, source))

    for r in ref_drugs:
        did = int(r["drug_id"])
        legacy_raw = r["drug_class"] or ""
        placed = False

        # 1) epocrates (single representative — no salt-sibling union)
        classes = list(dict.fromkeys(resolve_epo(r["generic_name"])))
        if classes:
            # Choose the PRIMARY class deliberately (epocrates order is not a
            # primacy ranking). Prefer the class whose therapeutic area matches
            # the drug's ATC anatomical group — so metformin's primary is
            # Endocrine/Diabetes, not its off-label Ob-Gyn/Infertility class.
            pref_area = (area_from_atc(atc_by_drug.get(did, "")) if atc_by_drug.get(did) else None) \
                or area_from_legacy(legacy_raw)
            primary_cls = None
            if pref_area:
                for cls in classes:
                    aid = epo_class_area.get(cls)
                    if aid and epo_name[aid] == pref_area:
                        primary_cls = cls
                        break
            if primary_cls is None:
                primary_cls = classes[0]
            for cls in classes:
                area_id = epo_class_area.get(cls)
                if not area_id:
                    continue
                place(did, epo_name[area_id], epo_name[cls], "epocrates", primary=(cls == primary_cls))
                placed = True
            if placed:
                stats["epocrates"] += 1
                continue

        subclass = clean_legacy_label(legacy_raw)

        # 2) known metabolic enzyme-replacement drug names override misleading
        #    ATC/legacy ("Enzyme Gastrointestinal Agent" for a Gaucher drug)
        area = area_from_name(r["generic_name"])
        if area:
            place(did, area, subclass, "legacy", primary=True)
            stats["legacy"] += 1
            continue

        # 3) ATC anatomical group
        atc = atc_by_drug.get(did)
        area = area_from_atc(atc) if atc else None
        if area:
            place(did, area, subclass, "atc", primary=True)
            stats["atc"] += 1
            continue

        # 4) legacy keyword → area, else Other
        area = area_from_legacy(legacy_raw)
        if area:
            place(did, area, subclass, "legacy", primary=True)
            stats["legacy"] += 1
        else:
            place(did, OTHER_AREA, subclass, "legacy", primary=True)
            stats["other"] += 1

    c.executemany(
        "INSERT INTO drug_class_membership (drug_id, node_id, is_primary, source) VALUES (?,?,?,?)",
        membership,
    )

    # prune areas that ended up with no drugs (e.g. Alternative Medicines)
    c.execute("""DELETE FROM drug_class_nodes WHERE level = 0 AND id NOT IN (
        SELECT DISTINCT a.id FROM drug_class_nodes a
        JOIN drug_class_nodes s ON s.parent_id = a.id
        JOIN drug_class_membership m ON m.node_id = s.id)""")

    # ── report ──
    total = len(ref_drugs)
    placed_drugs = c.execute("SELECT COUNT(DISTINCT drug_id) FROM drug_class_membership").fetchone()[0]
    n_area = c.execute("SELECT COUNT(*) FROM drug_class_nodes WHERE level=0").fetchone()[0]
    n_sub = c.execute("SELECT COUNT(*) FROM drug_class_nodes WHERE level=1").fetchone()[0]
    print(f"drugs placed: {placed_drugs}/{total} ({100*placed_drugs/total:.1f}%)")
    print(f"source mix: {stats}")
    print(f"areas: {n_area}   subclasses: {n_sub}")
    print("\narea distribution (distinct drugs):")
    rows = c.execute("""
        SELECT a.name, COUNT(DISTINCT m.drug_id) n, COUNT(DISTINCT s.id) subs
        FROM drug_class_nodes a
        JOIN drug_class_nodes s ON s.parent_id = a.id
        JOIN drug_class_membership m ON m.node_id = s.id
        WHERE a.level = 0
        GROUP BY a.id ORDER BY n DESC""").fetchall()
    for r in rows:
        print(f"   {r['name']:28s} {r['n']:4d} drugs  {r['subs']:3d} subclasses")

    if dry_run:
        c.rollback()
        print("\n(dry run — rolled back)")
    else:
        c.commit()
        print("\ncommitted")
    c.close()
    epo.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=None)
    ap.add_argument("--epocrates", type=Path, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    epo = args.epocrates
    if epo is None:
        for cand in (ROOT / "data" / "epocrates-imd" / "RX.sqlite",
                     ROOT / "epocrates-imd" / "RX.sqlite"):
            if cand.exists():
                epo = cand
                break
    if not epo or not Path(epo).exists():
        sys.exit("epocrates RX.sqlite not found")
    db = args.db or DRUG_REF_DB
    print(f"epocrates: {epo}\ntarget DB: {db}")
    build(Path(db), Path(epo), args.dry_run)


if __name__ == "__main__":
    main()
