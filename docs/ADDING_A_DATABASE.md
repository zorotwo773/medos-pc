# How to add a new content database to MedOS

> Audience: any human or AI engineer wiring a **new content source** (a book set,
> a drug/reference product, a guideline like Sanford, a DDx atlas, a qbank, …)
> into MedOS so that it is **searchable, hover-linked through UMLS, browsable in
> its own reader, and shipped to the phone**.
>
> Read this end-to-end before you touch code. MedOS is a *hub-and-spoke*
> architecture: every source plugs into the same handful of seams. If you skip a
> seam the source will silently half-work (e.g. it opens in its reader but never
> shows up in global search, or it searches but never appears in a hover card).
>
> Anchors below were verified against the tree on 2026-07-06 on branch
> `codex/pre-release-hardening`. Line numbers drift — **grep the symbol, don't
> trust the number.**

---

## 0. The mental model — UMLS is the center, everything else is a spoke

```
             raw vendor bundle (encrypted .db / PDFs / JSON)
                         │  build script (scripts/build_*.py)
                         ▼
      normalized <source>.sqlite   ──►  reader router  ──►  /source/... API  ──►  <source>/page.tsx reader
                         │                                                              ▲
                         │ iter_<source>() in build_global_search_index.py             │ Sidebar + Command palette
                         ▼                                                              │
              global_search.sqlite (entries)  ──────────────────────────────────────┐ │
                         │  tag_paragraphs.py (Aho-Corasick CUI tagger)              │ │
                         ▼                                                            │ │
              paragraph_concepts.sqlite  ──►  umls.sqlite (THE HUB, CUIs)  ◄─────────┘ │
                         │                          ▲                                  │
                         │  link_medos_to_umls.py   │                                  │
                         ▼                          │                                  │
              content_concepts.sqlite ─────────────┘                                  │
                         │                                                             │
                         └──►  /reference/concept-card  ──►  hover box (AmbossHtml)  ──┘
```

Two independent things must both happen for a source to feel "fully integrated":

1. **Retrieval** — the source's rows land in `global_search.sqlite` so the unified
   search finds them, *and* the reader router serves the full article.
2. **Concept linking** — those rows get tagged with UMLS CUIs
   (`paragraph_concepts` + `content_concepts`) so the source shows up in hover
   cards, the `/umls` hub page, the Related rail, and Concept Walk.

A source can have (1) without (2). It will look integrated until someone hovers a
term and your source is missing from the card. Do both.

---

## 1. Get the data into a **normalized SQLite** (the "explorable database")

Every MedOS reader serves a *normalized* SQLite that **the build script emits** —
never the raw vendor bundle at request time. Two reasons: (a) vendor bundles are
usually AES-encrypted per-document, and decrypting 500 KB of HTML per request is
too slow; (b) normalizing lets every reader share the same `topics` / `fts` /
`toc` shape.

### 1a. If the vendor bundle is encrypted (the common case)

Most bundles in `data/` (qbanks, UWorld library, UpToDate Pathways, AMBOSS) use a
**v2 AES-GCM** scheme. The pattern, reused verbatim across products:

- Key = `sha256(b"<MAGIC STRING>").digest()` — a per-product ASCII magic string.
  (Pathways/qbank magic: `"YHYZYNVLBEKPQCGDWFNPDAAIO"`.)
- Each ciphertext blob is prefixed `v2:` then base64 of `nonce(12) || ciphertext || tag(16)`.
- **AAD (additional authenticated data) varies per product** — this is the part
  you must discover:
  - UWorld library: AAD = `str(doc_id)`
  - Pathways / qbank: AAD = `f"{doc_id}|128"`
  - AMBOSS *library* uses an older **AES-CBC** scheme entirely (not v2) — proof
    that you cannot assume; you must inspect.
- Reference implementations to copy: `app/backend/uworld_library_reader.py`
  (`_decrypt_*`), `app/backend/scripts/build_pathways.py`, `qbank_reader.py`
  (`_decrypt_v2`), `amboss_crypto.py`.

**Discovering an unknown scheme:** open the raw `.db` in the sqlite CLI, find the
table holding documents (often `Docs(id, doc, …)`), read one `doc` blob. If it
starts with `v2:` it's GCM — brute the AAD by trying `str(id)`, `f"{id}|128"`,
`""`, the title, etc., until `AESGCM.decrypt` stops raising `InvalidTag`. Log the
first successful `(magic, aad_template)` and hard-code it in your build script.

**Decoding gotcha (bit us on Pathways):** decrypted payloads are often an Angular
shell with the real JSON in a JS string literal (`window.inlineDt = "…"`). Do
**not** use `bytes.decode("unicode_escape")` — it mangles UTF-8 (`≥` → `â¥`).
Write a minimal unescaper that only collapses `\" \\ \/ \'` and hands everything
else to `json.loads`.

### 1b. Normalized schema (target shape)

Emit `data/<source>/<source>.sqlite` with, at minimum:

```sql
CREATE TABLE <source>_topics (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  topic_type  TEXT,          -- e.g. 'drug' | 'organism' | 'syndrome' | 'ddx'
  body_html   TEXT,          -- sanitized, self-contained (images rewritten to /source/image/…)
  toc_path    TEXT,          -- optional hierarchy string 'Antibacterials/Beta-lactams/…'
  plain_text  TEXT           -- stripped text, used for FTS + concept tagging
);
CREATE VIRTUAL TABLE <source>_fts USING fts5(
  title, plain_text, content='<source>_topics', content_rowid='id',
  tokenize='porter unicode61'
);
-- keep an external_id ↔ title map if you need cross-source joins
```

Build the FTS with `porter unicode61` (matches every other MedOS FTS table) and
populate it from the content table so `rank` works. Sanitize `body_html` to be
**self-contained** — rewrite `<img src="../Images/x.jpg">` to your reader's image
route (`/source/image/x.jpg`) and strip `<link>`/`<script>` tags the vendor shell
references but you don't ship (see UWorld library reader for the regex approach).

Put the script at `app/backend/scripts/build_<source>.py`. It must be
**re-runnable + non-destructive**: write to a `*.tmp`, then atomically `os.replace`
onto the real path, so a running backend that holds the DB open doesn't corrupt.

---

## 2. Backend reader router

Clone the closest existing router (`uworld_library_reader.py` for article+TOC
products; `pathways_reader.py` for graph/journey products; the current
`routers/sanford.py` stub for a flat topic list). A reader router exposes:

- `GET /<source>/search?q=&limit=` — FTS5 over `<source>_fts`
- `GET /<source>/topic/{id}` (or `/{id}`) — full `body_html`
- `GET /<source>/tooltip?term=` — compact hover payload (see §5)
- `GET /<source>/image/{name}` — if the source has figures
- `GET /<source>/health` — `{configured, exists, topic_count}` so `/health` and
  the boot status page can report it

Open the DB **read-only** (`sqlite3.connect("file:…?mode=ro", uri=True)`) and
raise `503` with a clear "not built yet" message when the file is missing (the
stub routers already do this — good pattern to keep).

Register it in `app/backend/main.py`:

```python
from routers.<source> import router as _<source>_router   # near the other imports
app.include_router(_<source>_router)                       # near line ~379
```

Add the path to `config.py` next to the peers (don't hard-code it in the router —
put `SANFORD_DIR = _portable_path("SANFORD_DIR", ROOT / "data" / "sanfordguide")`
in `config.py` and import it, so `.env` can override it and `/health` can report
it). Add the resolved path to `config.describe()`.

---

## 3. Global search index (retrieval seam) — **do not skip**

Search is aggregated, not federated: at build time every source is flattened into
one `global_search.sqlite` `entries` table.

In `app/backend/scripts/build_global_search_index.py`:

1. Write `iter_<source>() -> list[dict]` next to `iter_uworld_library()`
   (~line 132). Emit one `entry(source, kind, external_id, title, subtitle, href,
   search_text, weight)` per topic. `href` must be the **frontend** route your
   reader page reads, e.g. `/sanford?id={id}`. `weight` sets base ranking
   (books=270, diseases=250, drugs≈300 — pick a peer; guideline sources like
   Sanford can sit high, ~300).
2. Register `iter_<source>` in the loader list so a full rebuild includes it.
3. Rebuild: `python scripts/build_global_search_index.py`.

### 3.1 Search grouping (`routers/search.py`)

Add your source key to **both**:
- `_GROUP_MAP` (~line 113) — maps the raw `scope`/`source` string to a group id.
- `_SOURCE_DIVERSITY_ORDER` (~line 121) — controls round-robin ordering in the
  flat "All" list. **Earlier = surfaces first.** (Sanford is already placed at
  index 1, right after `umls`, so an antibiotic query floats Sanford to the top —
  this is the deliberate "Sanford takes priority for antibiotics" lever.)

> Ordering ≠ relevance. Diversity order only breaks ties across sources; within a
> source, bm25 `rank` still decides. To make Sanford *win* for antibiotics
> specifically (not just be near the top), also give antibiotic/organism topics a
> higher `weight` in `iter_sanford()` and/or special-case the drug-class in the
> grouped path.

### 3.2 Register it as a content pack (`app/backend/packs.py`)

MedOS ships as separately-downloadable content packs (see the "Modular content
packs" plan) instead of one monolithic `data/` folder — `packs.py` is the
single registry of what's shippable and `installed_search_sources()` is the
**only** function `search.py` may call to decide which `source` values are
currently eligible (see `_index_scope_allowed` / `_source_pack_allowed`). If
your new source isn't registered there, it is invisible to search the moment
someone runs a partial install, even though its rows exist in
`global_search.sqlite` — always add it, even for a source you expect everyone
to have.

1. Decide: does this source belong in an **existing** pack (e.g. a small
   always-on reference joins `core`; a new UpToDate-like bundle might join
   `uptodate`), or does it need its **own** pack (own torrent paths, own
   toggle in the Content Manager)? Prefer joining an existing pack unless the
   source is independently large/optional enough that some users will skip
   it.
2. Add (or extend) a `Pack(...)` entry in `PACKS` (`packs.py`): `id`, `name`,
   `description`, `approx_size_gb`, `markers` (paths that prove it's
   extracted — reuse the `config.py` constant you just added in §2, don't
   hard-code a string), `search_sources` (the exact `source` values your
   `iter_<source>()` in §3 emits), and a `probe` — a **real** functional
   check (open the DB read-only, run one query that would fail on a
   truncated/corrupt download), not just "does the marker file exist".
   `_sqlite_probe(path, "SELECT count(*) FROM <your_table>")` covers most
   cases; see `_utd_probe`/`_amboss_probe`/`_qbank_probe` for richer examples.
3. Add `"<pack-id>": 1` to `SUPPORTED_SCHEMA` (schema version 1 for a new
   pack; bump it later only if the on-disk shape changes in a way old readers
   would misinterpret).
4. Sidebar / palette: give the relevant `Leaf`/vendor entries in
   `Sidebar.tsx` a `pack: "<pack-id>"` field (see `packAvailable()` in
   `app/lib/usePackSources.ts`) so the module greys out with a "get this
   pack" link into the Content Manager instead of 404ing when the pack isn't
   installed yet. If the source has its own scope chip in
   `GlobalCommandCenter.tsx`'s `SCOPE_FILTERS`, no extra wiring is needed
   there — chips are filtered generically by `sourceAvailable()` against the
   same `search_sources`.
5. Packaging / distribution: add the source's on-disk paths to its pack in
   `PACK_TORRENT_PATHS` (`pack_paths.py`) — MedOS distributes the live data
   tree as one multi-file torrent, so there is no separate 7z packaging list.
   Keep this file and `packs.py`'s `markers`/`search_sources` in lockstep. If
   the source's bytes live *inside* a broader pack's folder (like the First Aid
   PDF inside `data/books`), add the relative file to that broader pack's entry
   in `PACK_EXCLUDE_FILES` so the bytes aren't counted or shipped twice.
6. Re-run the regression harness (`python scripts/test_search_regression.py
   check`) — a full install (every pack green) must produce **zero** diff.
   If you added a brand-new pack id, also add a `cmd_partial`-style case so a
   future change can't silently make your source un-gate-able.

---

## 4. UMLS hub linkage (concept seam) — **do not skip**

This is what makes the source appear in hover cards, `/umls?cui=`, the Related
rail, and Concept Walk.

Run **in this order** after §3 (each writes tmp + atomic swap):

1. `python scripts/build_global_search_index.py`   (§3)
2. `python scripts/umls/tag_paragraphs.py`          — Aho-Corasick tags every
   `entries` row with the CUIs whose terms appear in title+search_text →
   `paragraph_concepts.sqlite`. **Source-agnostic**, so once you're in
   `global_search` you're tagged for free.
3. `python scripts/umls/link_medos_to_umls.py`      — title-exact CUI links →
   `content_concepts.sqlite`. This one has a **hardcoded source allowlist**
   (grep `allowlist` / the source-name set, ~line 85). **Add your source string**
   or the concept card / Related rail won't lead with your source's canonical
   article.

Verify: `SELECT COUNT(*) FROM paragraph_concepts WHERE …` includes your source's
rows, and `content_concepts` has your source.

---

## 5. Hover box (the reference layer) — priority & badges

The hover system lives in `app/components/amboss/AmbossHtml.tsx`. It underlines
terms (from `/reference/doc-terms`, precomputed CUIs) and, on hover, fetches a
centralized cross-source card from `/reference/concept-card?cui=`
(`app/backend/reference_reader.py`).

To integrate a new source into the **card**:
- Backend: add your source to `_CARD_SOURCE_ORDER` in `reference_reader.py`
  (order = which source leads the card). The card is a balanced top-N-per-source
  window over `paragraph_concepts` — once §4 is done, your rows are eligible.
- Frontend: extend the `HoverSource` union type, `actionBadge()` (2-letter badge,
  e.g. `SF` for Sanford, `Dx` for UTD DDx), `actionLabel()`, and the routing in
  `openMatch`/`onOpenMatch`. Add a badge colour in `globals.css`
  (`.medos-tooltip-action-<source>`).

**Priority (the antibiotic ask):** `matchPriority()` decides which source is
*featured* on the card. Default drug reference is priority 0. To make Sanford win
for an antibiotic/organism, give `source === "sanford"` a priority **below** the
drug reference (e.g. `-1`) — but scope it: only when the concept's
`semantic_group` is `drug`/`chemical` *or* the topic type is antibiotic/organism,
so Sanford doesn't hijack non-antimicrobial drug hovers. The `/reference/scan`
and `tooltipUrl`/`referenceTooltipUrl` builders in AmbossHtml must also know your
`/source/tooltip` endpoint.

---

## 6. Frontend reader page + navigation

- Page: `app/app/<source>/page.tsx`. Clone the closest reader
  (`UWorldLibraryReader.tsx` for article+TOC; the Pathways components for a
  journey UI). **Read `node_modules/next/dist/docs/` first** — per
  `app/AGENTS.md`, this Next.js has breaking changes vs. what you know.
  - Scroll gotcha: the app shell `<main class="app-main">` has a fixed height and
    `overflow:hidden`, so a content page's own `<main>` must be
    `flex:1; min-height:0; overflow-y:auto` (NOT `min-height:100vh`) or it clips.
- Sidebar: add a leaf under the right group (Tools, Library, …) in
  `app/components/layout/Sidebar.tsx`, with a module accent token
  `--mod-<source>` in `globals.css` (Pathways used rose `#DB2777`; pick a
  distinct hue).
- Command palette + shortcut: `app/components/layout/GlobalCommandCenter.tsx`
  (add a command; Pathways/UWorld-lib use a `g <letter>` chord).
- TabBar: add an entry if the source should be openable as a persistent tab.

---

## 7. Phone (Android) parity

The phone reuses the **same** `global_search.sqlite` (byte-identical) and
per-source SQLite bundles. Steps in `phone/app/src/main/java/com/example/myapplication`:

- `DatabaseManager.kt` — add a `get<Source>Db()` accessor + any image dir.
- `data/SearchService.kt` — add the source to `SearchSource` enum,
  `GROUP_ORDER`, `SOURCE_CAP` (per-source bucket cap — this is what stops one
  source flooding results), `sourceFromString()`, and `navTargetFor()` /
  `refIdFromGlobal()` so search results and concept-card items route to the
  reader.
- New `ui/<Source>Screen.kt` reader + a `Screen.<Source>` route.
- Data packaging: `phone/pack_phone.ps1` — copy the normalized `<source>.sqlite`
  (+ images) into the bundle. **`VACUUM INTO` a copy** rather than copying the
  live file (the backend holds it WAL-locked). Group-scoped incremental importer
  means partial zips are only safe on fresh APK installs.
- Screenshots are blocked by `FLAG_SECURE`; verify via logcat + driving the UI.

---

## 8. Rebuild / deploy order (cheat sheet)

```
# 1. Produce the normalized DB from the vendor bundle
python app/backend/scripts/build_<source>.py

# 2. Fold it into unified search + the UMLS hub (order matters)
python app/backend/scripts/build_global_search_index.py
python app/backend/scripts/umls/tag_paragraphs.py
python app/backend/scripts/umls/link_medos_to_umls.py   # ensure source is allowlisted

# 3. Register it in app/backend/packs.py (§3.2) and re-run the regression harness
python app/backend/scripts/test_search_regression.py check

# 4. Restart the backend (python main.py — no --reload) to pick up new routers/DBs
# 5. Frontend is HMR; hard-reload for new routes
# 6. Phone: re-run pack_phone.ps1, rebuild APK, adb install -r
# 7. Distribution: add the source's paths to PACK_TORRENT_PATHS in
#    app/backend/pack_paths.py (the multi-file data torrent ships the live tree)
```

## 9. Gotchas that have bitten us

- `global_search.entries` has **no index on `external_id`** → concept-card /
  media joins do full scans. Build an O(1) in-memory map or add the index.
- Backend runs `python main.py` **without `--reload`** — backend changes need a
  manual restart to go live. Frontend is HMR.
- All index builders write `*.tmp` + atomic swap. If the backend holds the DB
  open on Windows the rename fails silently and the *old* DB stays — restart the
  backend before rebuilding, or expect stale data.
- Never CDN anything; fonts/assets are self-hosted and public-gated.
- `preview_screenshot` times out on iframe/media-heavy pages — verify via DOM.
- Forgetting §3.2 (pack registration) is the new easy way to half-ship a
  source: it works perfectly on your full-install dev box (nothing gates it
  there) and then silently vanishes from search for anyone on a partial
  install, because `installed_search_sources()` never learned your source
  belongs to a pack that's actually present. There is no error — the rows
  are just never selected. Always register it, even for "everyone will have
  this anyway" sources.

---

## Appendix A — Sanford Guide & UTD DDx (built 2026-07-06)

Both were integrated end-to-end (desktop). **Neither source is encrypted** — a
useful counter-example to §1a: not every bundle needs decryption. Discover the
format first; only reach for crypto if the payload is actually a `v2:` blob.

**Sanford Guide** — source `data/sanfordguide/sanfordguide/` is an unpacked
static-HTML mobile app: per-topic `<slug>.html` + images + `FTS.db`
(`search_base(path,title,subject,keywords,contentType,tradeName,searchableText)`,
1,248 topics; the richer of the two shipped editions). `contentType` is a numeric
code → we map it to kind (2=Antimicrobial, 3=Organism, 1=Clinical Condition, …).
- Build: `scripts/build_sanford.py` → `data/sanfordguide/sanford.sqlite`
  (`sanford_topics` + `sanford_fts`). Sanitizes each body once (bs4: strips vendor
  CSS/JS + Sanford chrome elements, rewrites internal `*.html` links to
  `data-sanford-slug`, rewrites `<img>` to `/sanford/asset/<name>`).
- Reader: `routers/sanford.py` (`/sanford/search|browse|topic/{id}|topic-by-slug|
  asset/{name}|tooltip|health`). Config: `SANFORD_DIR/SANFORD_ASSET_DIR/SANFORD_DB`.
- Frontend: `app/app/sanford/page.tsx` + `components/sanford/SanfordRoot.tsx`
  (index + article via `<AmbossHtml source="sanford">` for in-article hover).

**UTD DDx** — source `data/uptodate ddx/uptodateddx.db` is plain SQLite:
`diagnoses(id,diagnosisName,ismain)` + `ddx(id1,id2,id1diagnosis,id2diagnosis,
signs,tests)` — a differential matrix (854 presenting dx, 6,555 differentials).
- Build: `scripts/build_utdddx.py` → `data/uptodate ddx/utdddx.sqlite`
  (`ddx_topics`, `ddx_differentials`, `ddx_fts`; fixes run-together vendor text).
- Reader: `routers/utd_ddx.py` (`/utdddx/search|browse|topic/{id}|tooltip|health`).
- Frontend: `app/app/utdddx/page.tsx` + `components/utdddx/UtdDdxRoot.tsx`.

**Cross-cutting (done):** `iter_sanford`/`iter_utdddx` + a generic
`--sources a,b` incremental path in `build_global_search_index.py`; `_query_sanford`/
`_query_utdddx` live queriers in `search.py`; `sanford`/`utdddx` in `_GROUP_MAP` +
`_SOURCE_DIVERSITY_ORDER`; UMLS `link_medos_to_umls` allowlist; `paragraph_concepts`
re-tagged (sanford 1,446 / utdddx 5,715 hits); `_CARD_SOURCE_ORDER` in
`reference_reader.py`; AmbossHtml `HoverSource`/`matchPriority`/badges/routing;
`--mod-sanford`/`--mod-utdddx` accents + reader CSS; Sidebar + command-palette
(`g v` / `g x d`) entries.

**Antibiotic priority (the core ask), implemented in three layers:**
1. `iter_sanford` weight — antimicrobial topics = 700, organism = 620 (above
   drugs=560, firstaid=650, utd=420), so an antibiotic query leads with Sanford.
2. `_SOURCE_DIVERSITY_ORDER` — `sanford` at index 1 floats it in the grouped list.
3. `matchPriority` (AmbossHtml) — `source==="sanford"` returns −1 (above drug=0),
   and `_CARD_SOURCE_ORDER` puts sanford second, so the hover card leads with
   Sanford. Verified: amoxicillin/ceftriaxone cards lead with sanford.

**Remaining:** phone (Android) parity — §7 (SearchService `SANFORD`/`UTDDDX`
enum + GROUP_ORDER/SOURCE_CAP + nav; reader Screens; `pack_phone.ps1` bundles
`sanford.sqlite`+assets and `utdddx.sqlite`). Manual step: restart the backend
(`python main.py`) after a data rebuild.
