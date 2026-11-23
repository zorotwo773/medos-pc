import sqlite3, json
from pathlib import Path

BASE = Path("D:/ML/data/net.imedicaldoctor.imd/files/imduptodate2026-3-5")
OUT  = Path("D:/ML/data/utd_deep_inspect2.txt")

lines = []
def p(*args):
    s = " ".join(str(a) for a in args)
    print(s)
    lines.append(s)

def db_tables(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = c.cursor()
    tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    return c, cur, tables

# ── fcontentsearch.db ─────────────────────────────────────────────────
p("=" * 70)
p("FILE: fcontentsearch.db (838 MB)")
p("=" * 70)
c2, cur2, tables2 = db_tables(BASE / "fcontentsearch.db")
p("TABLES:", tables2)
for tbl in tables2[:4]:  # only first 4
    try:
        cur2.execute(f"SELECT * FROM {tbl} LIMIT 0")
        cols2 = [d[0] for d in cur2.description]
        cnt2  = c2.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        p(f"\nTABLE: {tbl}  rows={cnt2}  cols={cols2}")
        rows2 = cur2.execute(f"SELECT * FROM {tbl} LIMIT 2").fetchall()
        for ri, row in enumerate(rows2):
            for ci, val in enumerate(row):
                if val is None:
                    p(f"  [{ri}] {cols2[ci]}: NULL")
                elif isinstance(val, (bytes, bytearray)):
                    p(f"  [{ri}] {cols2[ci]}: <bytes {len(val)}>")
                elif isinstance(val, str) and len(val) > 80:
                    p(f"  [{ri}] {cols2[ci]}: str({len(val)}) = {repr(val[:300])}")
                else:
                    p(f"  [{ri}] {cols2[ci]}: {repr(str(val))[:150]}")
    except Exception as e:
        p(f"  ERROR on {tbl}: {e}")
c2.close()

# ── unidex.en.sqlite ─────────────────────────────────────────────────
p()
p("=" * 70)
p("FILE: unidex.en.sqlite (101 MB)")
p("=" * 70)
c3, cur3, tables3 = db_tables(BASE / "unidex.en.sqlite")
p("TABLES:", tables3)
for tbl in tables3:
    try:
        cur3.execute(f"SELECT * FROM {tbl} LIMIT 0")
        cols3 = [d[0] for d in cur3.description]
        cnt3  = c3.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        p(f"\nTABLE: {tbl}  rows={cnt3}  cols={cols3}")
        rows3 = cur3.execute(f"SELECT * FROM {tbl} LIMIT 3").fetchall()
        for ri, row in enumerate(rows3):
            parts = [f"{cols3[ci]}={repr(str(val)[:80])}" for ci, val in enumerate(row)]
            p(f"  [{ri}] " + " | ".join(parts))
    except Exception as e:
        p(f"  ERROR on {tbl}: {e}")
c3.close()

# ── utd_index.sqlite ─────────────────────────────────────────────────
p()
p("=" * 70)
p("FILE: utd_index.sqlite (4.3 MB)")
p("=" * 70)
idb = BASE / "utd_index.sqlite"
c4, cur4, tables4 = db_tables(idb)
p("TABLES:", tables4)
for tbl in tables4:
    try:
        cur4.execute(f"SELECT * FROM {tbl} LIMIT 0")
        cols4 = [d[0] for d in cur4.description]
        cnt4  = c4.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        p(f"\nTABLE: {tbl}  rows={cnt4}  cols={cols4}")
        rows4 = cur4.execute(f"SELECT * FROM {tbl} LIMIT 3").fetchall()
        for ri, row in enumerate(rows4):
            parts = []
            for ci, val in enumerate(row):
                if isinstance(val, str) and len(val) > 200:
                    try:
                        parsed = json.loads(val)
                        p(f"  [{ri}] {cols4[ci]}: JSON  top_keys={list(parsed.keys())[:10]}")
                        for k2, v2 in list(parsed.items())[:5]:
                            if isinstance(v2, str):
                                p(f"    .{k2}: str({len(v2)}) = {repr(v2[:100])}")
                            elif isinstance(v2, list):
                                p(f"    .{k2}: list[{len(v2)}]")
                                if v2 and isinstance(v2[0], dict):
                                    p(f"      [0] keys: {list(v2[0].keys())[:8]}")
                            elif isinstance(v2, dict):
                                p(f"    .{k2}: dict keys={list(v2.keys())[:6]}")
                            else:
                                p(f"    .{k2}: {repr(v2)[:80]}")
                    except Exception:
                        parts.append(f"{cols4[ci]}=str({len(val)})")
                else:
                    parts.append(f"{cols4[ci]}={repr(str(val)[:80])}")
            if parts:
                p(f"  [{ri}] " + " | ".join(parts))
    except Exception as e:
        p(f"  ERROR on {tbl}: {e}")
c4.close()

# ── utdtoc.db ─────────────────────────────────────────────────────────
p()
p("=" * 70)
p("FILE: utdtoc.db (19.9 MB)")
p("=" * 70)
c5, cur5, tables5 = db_tables(BASE / "utdtoc.db")
p("TABLES:", tables5)
for tbl in tables5:
    try:
        cur5.execute(f"SELECT * FROM {tbl} LIMIT 0")
        cols5 = [d[0] for d in cur5.description]
        cnt5  = c5.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        p(f"\nTABLE: {tbl}  rows={cnt5}  cols={cols5}")
        rows5 = cur5.execute(f"SELECT * FROM {tbl} LIMIT 5").fetchall()
        for ri, row in enumerate(rows5):
            parts = [f"{cols5[ci]}={repr(str(val)[:60])}" for ci, val in enumerate(row)]
            p(f"  [{ri}] " + " | ".join(parts))
    except Exception as e:
        p(f"  ERROR on {tbl}: {e}")
c5.close()

# ── utdqf.sqlite ─────────────────────────────────────────────────────
p()
p("=" * 70)
p("FILE: utdqf.sqlite (16 MB) - autocomplete / quickfind")
p("=" * 70)
c6, cur6, tables6 = db_tables(BASE / "utdqf.sqlite")
p("TABLES:", tables6)
for tbl in tables6:
    try:
        cur6.execute(f"SELECT * FROM {tbl} LIMIT 0")
        cols6 = [d[0] for d in cur6.description]
        cnt6  = c6.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        p(f"\nTABLE: {tbl}  rows={cnt6}  cols={cols6}")
        rows6 = cur6.execute(f"SELECT * FROM {tbl} LIMIT 5").fetchall()
        for ri, row in enumerate(rows6):
            parts = [f"{cols6[ci]}={repr(str(val)[:80])}" for ci, val in enumerate(row)]
            p(f"  [{ri}] " + " | ".join(parts))
    except Exception as e:
        p(f"  ERROR on {tbl}: {e}")
c6.close()

# ── Key finding summary ───────────────────────────────────────────────
p()
p("=" * 70)
p("CONFIRMED STRUCTURE SUMMARY")
p("=" * 70)
p("""
utdasset_decrypted.sqlite:
  - 1 table: topic_content (id, content)
  - content = JSON blob, EVERY row has:
      * bodyHtml    : str (avg 81,496 chars) - THE FULL ARTICLE HTML
      * outlineHtml : str - section outline  
      * topicInfo   : dict {id, type, subtype, title, specialtyId, lastMajorUpdateMs}
      * relatedTopics: dict {topics: [{id, title, type, subtype}]}
      * relatedGraphics: list [{graphicInfo: {id, displayName, subtype}}]
      * contributors: list (not always present)
      * drugDisclosureHtml: str (drug topics)
      * formatVersion: int
  - NO 'sections' key - sections are EMBEDDED in bodyHtml as HTML divs
  - topicInfo.type: 'medical' | 'drug'
  - topicInfo.subtype: 'medical_review' | 'drug_patient' | etc.
""")

OUT.write_text("\n".join(lines), encoding="utf-8", errors="replace")
print(f"\nOutput written to: {OUT}")
