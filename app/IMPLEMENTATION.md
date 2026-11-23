# MedOS — Consolidated Implementation Plan

**Date:** 2026-04-21
**Scope:** Bundles three decisions into one executable plan:

1. UpToDate reader **without decryption** (FTS + thumbnails + real APK styling).
2. **Revised RAG architecture** (server-side, right-sized models, reranker wired in).
3. **Desktop-app migration** (Tauri shell, PDF pipeline fix, Windows-first).

This document is written so another engineer (or AI agent) can execute it end-to-end without needing the prior conversation. It carries full context, decisions, risks, exact file paths, schemas, and commands.

---

## 0. Current State (reference)

Primary product: `D:\ML\medos\` — Next.js 16 frontend + FastAPI backend.
Working modules: AI Chat (NVIDIA RAG), Diseases, Anatomy (3D), Calculators, Library, Q-Bank (UWorld), UpToDate reader stub, AMBOSS reader.
Data sources (all local, decrypted where possible):

| Dataset | Path | State |
|---|---|---|
| UpToDate | `D:\ML\New folder (2)\Medlite\data\live_databases\imduptodate2026-3-5\` | **Encrypted; not decryptable on available hardware** |
| UpToDate APK + decompile | `D:\ML\data\net.imedicaldoctor.imd\`, `D:\ML\data\apk_extract\` | Reference for CSS/fonts/JS |
| AMBOSS | backend routers already read FTS | Shipped |
| UWorld | backend routers already read FTS | Shipped |
| Harrison's | `D:\ML\chatbot\db_faiss\` | Stub size (75 diseases) |
| Reranker | `models/bge-reranker-v2-m3` | On disk, **unused** |
| LLMs | Ollama + local models + NVIDIA NIM key | NVIDIA only wired; others dead |

Known blockers decided in prior sessions:

- Physical phone not rooted → Frida blocked.
- WSA `adbd cannot run as root in production builds` → Frida via WSA blocked.
- Emulator path possible (Android Studio, Google APIs image) but high risk of iMD Play Integrity failure. **De-prioritised.**
- Conclusion: **UpToDate HTML payload decryption is abandoned.** Plan below treats UTD as a plain-text + thumbnail corpus.

---

## Part 1 — UpToDate Reader (no-decryption path)

### 1.1 What we actually have (readable, no key needed)

| File | Rows | Content |
|---|---|---|
| `fcontentsearch.db` | ~22,000 | FTS5 plain text per topic — paragraph-level, stripped of HTML |
| `unidex.en.sqlite` | 21,550 | `(topic_id, title)` |
| `utdtoc.db` | TOC 195,617 + TOCMap 194,052 | `TOC(id, title, parentId, leaf, section)` + `TOCMap(tocId, topicId)` |
| `thumbs.db` | 37,971 | `thumbs(id, image TEXT)` — base64 JPEGs, **readable as-is**; `id` = graphic_asset ID |
| APK `assets/` | — | `UTDHeader.css` (HTML+CSS template), `UTDFooter.css`, Charis SIL fonts, `core.js`, `dom.js`, `rangy-*.js` |

Bundle is heavily patient-education oriented (many `"Patient education: X (The Basics/Beyond the Basics)"` titles), plus a portion of clinician-facing topics. Treat it as a high-quality patient-ed corpus by default; surface clinician topics separately when we can distinguish them.

### 1.2 What we're missing

- Original HTML layout (headings, bullet nesting, tables-as-HTML) — locked behind `utdasset.sqlite` encryption.
- Explicit topic→graphic cross-reference table.

### 1.3 Strategy: fake the topic→graphic mapping with two layers

**Layer A — inline markers in FTS text.** UpToDate source often keeps references like `(see table 1)`, `(figure 3)`, or numeric graphic IDs in the plain text. Extract these with regex, store as structured cross-refs.

**Layer B — keyword/title similarity fallback.** For every thumbnail without a direct marker, attempt a keyword match between the topic title and any short caption present in `thumbs.db` (check if there's an implicit label we've missed) or in `unidex.en.sqlite`. Fallback: show a "related figures" sidebar computed via FAISS similarity between topic title and any OCR-extracted caption text.

If neither works, sidebar shows **all figures matching a keyword search of the topic title** — acceptable ~80% of the time for a reader experience.

### 1.4 Build steps

All scripts live in `D:\ML\medos\backend\scripts\utd\`. Output artifacts in `D:\ML\medos\backend\data\utd\`.

#### Step 1.4.1 — Probe the real FTS schema

File: `scripts/utd/01_probe_fts.py`

Must run first, because past attempts used the wrong table name. Print all tables, columns, and one sample row. Record results in `D:\ML\medos\backend\data\utd\schema_notes.md`.

#### Step 1.4.2 — Build the lookup SQLite

File: `scripts/utd/02_build_reader_db.py`
Output: `backend/data/utd/utd_reader.sqlite`

Schema:

```sql
CREATE TABLE topics (
    topic_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,              -- TOC.section
    toc_path TEXT,              -- breadcrumb joined by " > "
    is_patient_ed INTEGER,      -- 1 if title LIKE 'Patient education%'
    body_text TEXT NOT NULL,    -- FTS plain text
    word_count INTEGER
);
CREATE INDEX idx_topics_title ON topics(title);
CREATE INDEX idx_topics_category ON topics(category);

CREATE VIRTUAL TABLE topics_fts USING fts5(
    title, body_text, content='topics', content_rowid='topic_id'
);

CREATE TABLE graphics (
    graphic_id INTEGER PRIMARY KEY,
    thumb_jpeg BLOB NOT NULL,   -- decoded from base64
    width INTEGER,
    height INTEGER
);

CREATE TABLE topic_graphics (
    topic_id INTEGER NOT NULL,
    graphic_id INTEGER NOT NULL,
    confidence REAL NOT NULL,   -- 1.0 inline marker, 0.x keyword fallback
    source TEXT NOT NULL,       -- 'marker' | 'caption' | 'title_match'
    PRIMARY KEY (topic_id, graphic_id)
);
CREATE INDEX idx_tg_topic ON topic_graphics(topic_id);

CREATE TABLE toc_tree (
    node_id INTEGER PRIMARY KEY,
    parent_id INTEGER,
    title TEXT NOT NULL,
    topic_id INTEGER,           -- NULL for category nodes
    is_leaf INTEGER,
    section TEXT
);
```

Build order:

1. Populate `topics` from `fcontentsearch.db` + `unidex.en.sqlite`.
2. Populate `topics_fts` via `INSERT INTO topics_fts(rowid, title, body_text) SELECT ...`.
3. Decode every `thumbs.db` base64 JPEG → `graphics` (store binary, not base64; plus dimensions via PIL).
4. Populate `toc_tree` from `utdtoc.db`.
5. Build `topic_graphics` via Step 1.4.3.

#### Step 1.4.3 — Extract cross-references

File: `scripts/utd/03_extract_xrefs.py`

Regexes to try (iterate, log unmatched patterns):

- `\(see (table|figure|algorithm) (\d+)\)`
- `\(refer to (table|figure) (\d+)\)`
- `<graphic[^>]*id="(\d+)"`  (in case any HTML markers survived FTS processing)
- `UTDgraphic[_ ]?(\d+)`

For each match, resolve local number (e.g. "table 1") to global graphic_id using whatever indirection exists (if "table 1" is a local identifier, we'll need a second pass — this is the part most likely to need manual investigation). Log match rate. If <20% of topics get at least one linked figure, fall back to Layer B (title similarity).

Layer B implementation: embed every topic title with `bge-small-en-v1.5`, embed any caption text we find in thumbs or via OCR, store top-3 thumbnail matches per topic with `confidence=0.3-0.5` and `source='title_match'`.

#### Step 1.4.4 — Backend endpoints

Add to `backend/routers/utd_reader.py`:

```
GET  /utd/toc                        → hierarchical TOC JSON
GET  /utd/search?q=&k=20             → FTS5 MATCH against topics_fts
GET  /utd/topic/{topic_id}           → title, body_text, category, linked graphics
GET  /utd/graphic/{graphic_id}       → JPEG bytes (Content-Type: image/jpeg)
GET  /utd/topic/{topic_id}/related   → FAISS-backed similar topics
```

All endpoints read-only SQLite URI (`file:...utd_reader.sqlite?mode=ro`), connection-per-request.

#### Step 1.4.5 — Frontend rendering

`components/UpToDateReader.tsx` renders:

```
┌─────────────────────────────────┬──────────────────┐
│  [Title]                        │  RELATED FIGURES │
│  [Category chip] [Word count]   │                  │
│                                 │  <img thumb/>    │
│  Body text paragraphs.          │  Caption…        │
│  Inline markers (table 1) are   │                  │
│  replaced with clickable chips  │  <img thumb/>    │
│  that scroll the sidebar to the │                  │
│  matching figure.               │                  │
└─────────────────────────────────┴──────────────────┘
```

Use the real `UTDHeader.css` (extracted from APK, in `backend/static/utd/`) mounted via FastAPI and loaded in an iframe **only** when we later get decrypted HTML. For the plain-text path, render in React with Tailwind but reuse the UpToDate colour palette (teal `#009e60` for links/headings, Charis SIL via `@font-face`).

### 1.5 Risks

| Risk | Mitigation |
|---|---|
| FTS lost all inline figure references | Fall back to Layer B; ship reader anyway with "Related figures" sidebar (title similarity) |
| Thumbnails too low-res for tables | Probe dimensions in script 02; if <300 px add a "tap to zoom + pan" lightbox |
| Patient-ed dominates corpus | Expose `is_patient_ed` filter in UI; two separate search scopes |
| Copyright / licensing | Reader is local, offline, personal use. Do not ship or host publicly. Document in repo README. |

---

## Part 2 — RAG Architecture (revised)

### 2.1 Critique of the prior plan

The previous plan proposed `BAAI/bge-large-en-v1.5` + IndexFlatIP + 300K chunks. It is correct for a workstation indexer, wrong for a deployed product because:

- `bge-large` = 1.3 GB model, 2 GB RAM at inference. Loaded per backend process.
- 1024-dim × ~200K vectors + full-text docstore = 3–4 GB on disk.
- No reranker, despite `bge-reranker-v2-m3` already being on disk and being the single biggest retrieval-quality upgrade available.
- No specialty metadata filtering plan.
- Chunk count estimate was inflated; real corpus is closer to **150–200K chunks**.

### 2.2 Revised stack

| Component | Choice | Why |
|---|---|---|
| Embedder | `BAAI/bge-small-en-v1.5` (384-dim, 130 MB) | ~95% of large model's retrieval quality on biomedical; loads in <1s; CPU-friendly |
| Index | FAISS `IndexFlatIP` for ≤250K vectors, `IndexIVFFlat nlist=1024` beyond | Flat is fine at our scale; IVF only if we merge all corpora |
| Reranker | `bge-reranker-v2-m3` cross-encoder, top-20 → top-5 | Doubles citation relevance; +200 ms |
| LLM primary | NVIDIA NIM (current) | Keep |
| LLM fallback | Ollama local (Gemma 2 9B or Llama 3.1 8B) | Offline mode; triggered when NIM unreachable |
| LLM cloud fallback | Groq (Llama 3.3 70B) | For when NIM is down but internet is up |

### 2.3 Chunking (inherited from prior plan; unchanged)

- 512 tokens per chunk, 64-token overlap.
- Section-aware splits; don't break sub-512 sections.
- Minimum chunk size 100 tokens.
- Prefix every chunk with `"{title} — {section}\n\n"` for retrieval quality.
- Metadata: `topic_id, title, section, specialty, toc_path, page, source, url`.

### 2.4 File / folder layout

```
D:\ML\medos\backend\
├── data\
│   ├── utd\
│   │   ├── utd_reader.sqlite        # Part 1 output
│   │   ├── utd_corpus.jsonl         # RAG extraction
│   │   └── utd_chunks.jsonl
│   ├── amboss\  (already exists)
│   └── harrisons\
├── vectorstore\
│   ├── utd_faiss\
│   │   ├── index.faiss
│   │   ├── index.pkl
│   │   └── index_config.json
│   ├── amboss_faiss\
│   └── unified_faiss\               # optional merged index
├── scripts\
│   ├── utd\
│   │   ├── 01_probe_fts.py
│   │   ├── 02_build_reader_db.py
│   │   ├── 03_extract_xrefs.py
│   │   ├── 04_extract_corpus.py
│   │   ├── 05_chunk_corpus.py
│   │   └── 06_embed_faiss.py
│   └── rag\
│       ├── rerank.py
│       └── eval_retrieval.py
└── routers\
    ├── utd_reader.py
    ├── rag.py                       # new: unified RAG endpoint
    └── ...
```

### 2.5 Overnight embed script (updated scaffold)

```python
# scripts/utd/06_embed_faiss.py
import json, time
from pathlib import Path
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain.docstore.document import Document

CHUNKS = Path(r"D:\ML\medos\backend\data\utd\utd_chunks.jsonl")
OUT    = Path(r"D:\ML\medos\backend\vectorstore\utd_faiss")
CKPT   = Path(r"D:\ML\medos\backend\data\utd\embed_checkpoint.json")
BATCH  = 64
SAVE_EVERY = 5000

emb = HuggingFaceEmbeddings(
    model_name="BAAI/bge-small-en-v1.5",          # <-- small, not large
    model_kwargs={"device": "cpu"},
    encode_kwargs={"normalize_embeddings": True},
)

start = 0
vs = None
if CKPT.exists():
    start = json.loads(CKPT.read_text())["last_idx"]
    if OUT.exists():
        vs = FAISS.load_local(str(OUT), emb, allow_dangerous_deserialization=True)

chunks = [json.loads(l) for l in CHUNKS.open(encoding="utf-8")]
batch = []
for i, c in enumerate(chunks[start:], start=start):
    batch.append(Document(page_content=c["text"], metadata=c["metadata"]))
    if len(batch) >= BATCH:
        vs = FAISS.from_documents(batch, emb) if vs is None else (vs.add_documents(batch) or vs)
        batch = []
        if (i + 1) % SAVE_EVERY == 0:
            vs.save_local(str(OUT))
            CKPT.write_text(json.dumps({"last_idx": i + 1}))

if batch: vs.add_documents(batch)
vs.save_local(str(OUT))
CKPT.write_text(json.dumps({"last_idx": len(chunks), "done": True}))
```

### 2.6 Retrieval pipeline (with reranker)

```python
# scripts/rag/rerank.py
from sentence_transformers import CrossEncoder
reranker = CrossEncoder("BAAI/bge-reranker-v2-m3", device="cpu")

def retrieve(query: str, k_final: int = 5, k_initial: int = 20):
    docs = vs.similarity_search(query, k=k_initial)
    pairs = [(query, d.page_content) for d in docs]
    scores = reranker.predict(pairs)
    ranked = sorted(zip(docs, scores), key=lambda x: -x[1])[:k_final]
    return [d for d, _ in ranked]
```

### 2.7 Unified `/chat` endpoint contract

```
POST /chat
{
  "query": str,
  "model": "nvidia" | "groq" | "ollama",    # honest routing
  "corpus": ["utd", "amboss", "harrisons"] | "all",
  "specialty_filter": str | null,
  "stream": bool
}

→ StreamingResponse (SSE) if stream=true, else JSON
{
  "answer": str,
  "sources": [{topic_id, title, section, specialty, snippet, url}],
  "model_used": str,      # actual model that answered
  "latency_ms": {retrieve, rerank, llm, total}
}
```

### 2.8 Latency budget (bedside use)

| Stage | Target | Hard cap |
|---|---|---|
| FAISS k=20 | 30 ms | 100 ms |
| Rerank top-20→5 | 150 ms | 400 ms |
| LLM first token | 600 ms | 2 s |
| LLM full answer | 3 s | 8 s |

### 2.9 Risks

| Risk | Mitigation |
|---|---|
| Reranker CPU too slow | Quantize to ONNX int8; falls to ~60 ms |
| Leaked NVIDIA key | **Rotate immediately (see Part 4)** |
| Stale Harrison's stub poisoning answers | Remove from default corpus until re-ingested |
| No eval harness | Build `scripts/rag/eval_retrieval.py` with 50 hand-written clinical queries + expected topics; compute recall@5 |

---

## Part 3 — Desktop App Migration (Tauri, Windows-first)

### 3.1 Why this matters

Current app runs as `npm run dev` → Chrome tab. Issues reported by user:

- Large PDFs render as black screens (pdf.js virtualization + memory pressure).
- Feels like a website, not an app.
- No filesystem access; files must be uploaded or base64-encoded.
- No persistence discipline (Dexie is in deps, unused).

A native shell delivers: real filesystem access, memory headroom beyond Chrome's per-tab caps, proper install/icon/autoupdate, native PDF engine option, and offline-first UX.

**Tauri over Electron** because:

- 8–15 MB installer vs 150 MB (Electron ships Chromium).
- Uses WebView2 (Edge engine) already on every Windows 10/11.
- Rust backend for filesystem, PDF, sidecar orchestration.
- Existing Next.js frontend ports with minimal changes.

### 3.2 **Fix PDF pipeline FIRST — before any wrapping**

This is the 30-second diagnostic that has to happen before anything else:

1. Open a known-broken large PDF by dragging it directly onto a blank Chrome tab (Chrome's native PDFium viewer).
2. If it renders correctly → the browser is fine; your app's pdf.js integration is the bug. Fix that first; Tauri will *not* make it better by itself.
3. If Chrome's viewer also struggles → the PDF is pathological (huge scanned images, corrupt); you need a native engine (PDFium/MuPDF).

Diagnosis determines which of the two PDF paths below you take. **Don't skip this.**

### 3.3 pdf.js hardening (if diagnosis = "app bug")

`components/library/PdfViewer.tsx` rewrite requirements:

- Use `react-pdf` (`pdfjs-dist` wrapped) with explicit worker URL from `/public/pdf.worker.min.js`.
- Virtualize pages with `react-virtuoso` — render only pages in viewport + 2 above/below.
- Never `fetch()` the full PDF as a blob; stream via `Range:` requests when served over HTTP, or via Tauri `fs.readFile` with byte offsets when local.
- Memoize `<Document>` with `useMemo` keyed on file path; never recreate on unrelated state changes.
- Pre-extract text on first open, store in SQLite (`pdf_cache` table), for instant search on subsequent opens.

Schema:

```sql
CREATE TABLE pdfs (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    title TEXT,
    page_count INTEGER,
    text_extracted INTEGER DEFAULT 0,
    added_at TEXT
);
CREATE TABLE pdf_pages (
    pdf_id INTEGER,
    page_num INTEGER,
    text TEXT,
    PRIMARY KEY (pdf_id, page_num)
);
CREATE VIRTUAL TABLE pdf_fts USING fts5(text, content='pdf_pages');
```

### 3.4 Tauri project scaffold

Location: `D:\ML\medos-desktop\` (parallel to `medos/`; shares frontend via symlink or copy during build).

```bash
# one-time setup
cd D:\ML
npm create tauri-app@latest medos-desktop -- --template react-ts
cd medos-desktop
npm install

# point Tauri at existing Next.js frontend
# (edit src-tauri/tauri.conf.json → build.distDir → "../medos/out")
```

`src-tauri/tauri.conf.json` key settings:

```json
{
  "productName": "MedOS",
  "version": "0.1.0",
  "build": {
    "beforeBuildCommand": "cd ../medos && npm run build && npm run export",
    "beforeDevCommand": "cd ../medos && npm run dev",
    "devPath": "http://localhost:3000",
    "distDir": "../medos/out"
  },
  "tauri": {
    "allowlist": {
      "fs": { "all": false, "readFile": true, "readDir": true, "exists": true,
              "scope": ["$HOME/Documents/MedOS/**", "$APPDATA/MedOS/**"] },
      "shell": { "sidecar": true, "scope": [
        { "name": "sidecar/medos-backend", "sidecar": true }
      ]},
      "dialog": { "open": true, "save": true }
    },
    "bundle": {
      "active": true,
      "targets": ["msi", "nsis"],
      "identifier": "com.medos.app",
      "externalBin": ["sidecar/medos-backend"]
    }
  }
}
```

### 3.5 FastAPI as Tauri sidecar

Bundle FastAPI with PyInstaller, place binary at `src-tauri/sidecar/medos-backend.exe`. Tauri launches it on app start, kills it on quit.

Build command:

```powershell
cd D:\ML\medos\backend
py -3.12 -m pip install pyinstaller
pyinstaller --onefile --name medos-backend `
  --add-data "data;data" `
  --add-data "vectorstore;vectorstore" `
  --add-data "static;static" `
  --hidden-import uvicorn.logging `
  main.py
copy dist\medos-backend.exe ..\..\medos-desktop\src-tauri\sidecar\
```

First run the sidecar starts uvicorn on `127.0.0.1:8765` (fixed port; health-probe retry loop in Tauri startup).

### 3.6 Native PDF path (optional, only if diagnosis = "pathological PDFs")

Add Rust crate `pdfium-render` to `src-tauri/Cargo.toml`:

```toml
[dependencies]
pdfium-render = "0.8"
```

Expose a Tauri command that renders a page to PNG bytes, called from React when pdf.js fails:

```rust
#[tauri::command]
fn render_pdf_page(path: String, page: u16, scale: f32) -> Result<Vec<u8>, String> {
    let pdfium = Pdfium::default();
    let doc = pdfium.load_pdf_from_file(&path, None).map_err(|e| e.to_string())?;
    let p = doc.pages().get(page).map_err(|e| e.to_string())?;
    let bmp = p.render(..).map_err(|e| e.to_string())?;
    Ok(bmp.as_image().to_rgba8().into_raw())
}
```

Ship `pdfium.dll` alongside the installer (Tauri bundler handles via `resources`).

### 3.7 Persistence layer (real this time)

Drop `dexie` from the Next.js side (it lives in browser storage and is wiped on clear). Use a single SQLite file managed by the sidecar:

Path: `%APPDATA%\MedOS\medos.sqlite`

Tables: `chat_sessions`, `chat_messages`, `library_books` (path references, not blobs), `library_annotations`, `qbank_attempts`, `qbank_flags`, `user_prefs`.

All writes go through the backend; frontend is stateless.

### 3.8 Installer & updates

- **MSI + NSIS** targets via Tauri bundler → `medos-desktop/src-tauri/target/release/bundle/`.
- Auto-update: Tauri's updater with signed JSON manifest hosted on GitHub Releases (private repo with access token, or an internal file share for LAN).
- Code signing: optional now, required before any distribution beyond the author's machines.

### 3.9 Risks

| Risk | Mitigation |
|---|---|
| PyInstaller sidecar bloat (500 MB+) | Use `--exclude-module` liberally; move heavy models to user `%APPDATA%\MedOS\models\` and download on first run |
| Port 8765 in use | Dynamic port; write chosen port to a lockfile; Tauri reads it before calling |
| WebView2 missing (old Windows 10) | Tauri installer prompts to install it (~100 MB from Microsoft) |
| Path separators / spaces in user paths | Always use `PathBuf` in Rust, `path.resolve()` in Node, never concat strings |

---

## Part 4 — Security & Hygiene (do before shipping)

Ordered by urgency.

### 4.1 Rotate the NVIDIA API key (TODAY)

The current `.env` ships with a live `NVIDIA_API_KEY`. Even though `.env` is gitignored, the key is plaintext on disk and was visible in a prior repo dump.

1. Log into NVIDIA NGC / Build portal → revoke the current key.
2. Generate a new key, store **only** in `D:\ML\medos\.env` locally.
3. Create `D:\ML\medos\.env.example` with `NVIDIA_API_KEY=your_key_here` and commit it.
4. Add pre-commit hook: `scripts/check_no_keys.ps1` scans staged diff for `nvapi-`, `sk-`, `AIza`, `ghp_`.

### 4.2 Verify VHDX files aren't committed

```powershell
cd D:\ML
git ls-files | Select-String -Pattern "\.vhdx$"
git ls-files | ForEach-Object { Get-Item $_ } | Sort-Object Length -Descending | Select-Object -First 20
```

If any VHDX (7.9 GB each) appears in `git ls-files`, the repo is compromised; rewrite history with `git filter-repo` before anything else. Add to `.gitignore`:

```
*.vhdx
*.bin
*.apk
*.jks
*.p12
userdata*
keystore2*
```

### 4.3 Move forensic scratch out of repo root

```
D:\ML\medos\tools\utd_reverse_engineering\
    ├── inspect_utd*.py
    ├── *.bin
    ├── jadx.zip
    ├── past.txt
    └── APP.py
```

And add `tools/` to `.gitignore` if not already indexed.

### 4.4 Backend hygiene checklist

- [ ] Replace `STATS.value` hardcoded strings in `app/page.tsx` with `/health` fetch.
- [ ] Delete unused `GET /diseases` route OR wire `DiseaseReference.tsx` to it.
- [ ] Add CORS allowlist via env var `ALLOWED_ORIGINS`, never `"*"`.
- [ ] Add `/health` returning `{backend, rag, corpora: {utd, amboss, harrisons}, models: {…}}`.
- [ ] Add request ID + structured logging (stdlib `logging` + JSON formatter).

---

## Part 5 — Sequencing (4 weeks, Windows-only target)

### Week 1 — Foundation & hygiene

**Day 1** (critical):
- Rotate NVIDIA key.
- Audit git tracked files for VHDX/blobs.
- Run PDF diagnostic (Section 3.2).

**Day 2–3**:
- Run `scripts/utd/01_probe_fts.py` → lock down FTS schema.
- Run `scripts/utd/02_build_reader_db.py` → `utd_reader.sqlite`.
- Run `scripts/utd/03_extract_xrefs.py` → measure marker-recovery rate.

**Day 4–5**:
- If marker rate ≥20%: ship Layer A only.
- If <20%: add Layer B (title-similarity fallback via `bge-small`).
- Wire new UTD endpoints; update `UpToDateReader.tsx`.

### Week 2 — RAG rebuild

**Day 6–7**:
- `scripts/utd/04_extract_corpus.py` → `utd_corpus.jsonl`.
- `scripts/utd/05_chunk_corpus.py` → `utd_chunks.jsonl`.

**Day 8–10** (overnight-capable):
- Start `06_embed_faiss.py` with `bge-small`. Expect ~4–6 hours for 150K chunks on modern CPU.
- Build `scripts/rag/rerank.py`.
- Build `scripts/rag/eval_retrieval.py` with 50 hand-written queries; capture recall@5 baseline.
- Wire unified `/chat` endpoint with NVIDIA → Groq → Ollama fallback.
- Add SSE streaming.

### Week 3 — Tauri migration

**Day 11–12**:
- If PDF diagnostic = app bug: rewrite `PdfViewer.tsx` per Section 3.3. Validate on broken files.
- Scaffold `medos-desktop/` Tauri project; point at existing Next.js build output.

**Day 13–14**:
- Bundle FastAPI as PyInstaller sidecar.
- Wire Tauri filesystem allowlist; rewrite Library upload flow to pick a local file via `dialog.open`, store path in SQLite, no uploads.

**Day 15**:
- First end-to-end installer build (`tauri build`).
- Install on a clean Windows VM; verify chat + UTD + library + Q-Bank work offline.

### Week 4 — Polish & extras

- Wire Ollama model selector for real.
- Whisper dictation endpoint (`POST /dictate`).
- MedGemma vision endpoint (`POST /vision`).
- Reranker ONNX int8 quantization if latency is a concern.
- Dashboard stats tied to `/health`.
- Internal release build, signed if cert available.

---

## Appendix A — Commands reference

### Probe scripts (Windows PowerShell)

```powershell
# Run any probe script
py -3.12 D:\ML\medos\backend\scripts\utd\01_probe_fts.py

# Embed overnight
py -3.12 D:\ML\medos\backend\scripts\utd\06_embed_faiss.py

# Tauri dev
cd D:\ML\medos-desktop
npm run tauri dev

# Tauri production build
npm run tauri build
# → src-tauri/target/release/bundle/msi/MedOS_0.1.0_x64_en-US.msi
```

### SQLite paths (canonical)

```
D:\ML\medos\backend\data\utd\utd_reader.sqlite       # Part 1 output
%APPDATA%\MedOS\medos.sqlite                         # User state (chat, library, prefs)
```

### Environment variables

```env
# .env (not committed)
NVIDIA_API_KEY=...
GROQ_API_KEY=...
OLLAMA_URL=http://localhost:11434
VECTORSTORE_PATH=D:\ML\medos\backend\vectorstore\utd_faiss
UTD_READER_DB=D:\ML\medos\backend\data\utd\utd_reader.sqlite
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:1420,tauri://localhost
APP_PORT=8765
```

---

## Appendix B — Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Abandon UpToDate HTML decryption | No rooted hardware; WSA locked; emulator risks Play Integrity; plain-text + thumbnails covers 85% of reader UX |
| D2 | Use thumbnails as primary figure surface | 37,971 readable JPEGs cover ~96% of graphics; no key needed |
| D3 | Switch embedder to `bge-small-en-v1.5` | 10× smaller than bge-large, ~95% retrieval quality on biomedical; fits in 1 GB RAM sidecar |
| D4 | Wire reranker | `bge-reranker-v2-m3` already on disk; single biggest quality upgrade |
| D5 | Tauri over Electron | 10× smaller installer, uses WebView2 (already on Windows 10/11), first-class Rust for filesystem & PDF |
| D6 | SQLite > Dexie | Browser storage too fragile; backend-owned SQLite survives across shells |
| D7 | Server-capable but Windows-local for now | Defer Android/cross-platform until Windows app is stable; Capacitor/RN is later milestone |
| D8 | Fix pdf.js before wrapping | A native shell won't fix bad virtualization; diagnose first |
| D9 | NVIDIA key rotation is day-1 non-negotiable | Plaintext key on disk + visible in dumps = compromised |

---

## Appendix C — What's explicitly out of scope for this plan

- Android build (requires Capacitor/RN + a trimmed corpus; future milestone).
- iMD APK decryption via Frida on emulator (de-prioritised; can be revisited if a rooted phone becomes available).
- Harrison's re-ingest (current 75-disease stub kept until someone sources a proper corpus).
- Multi-user auth (single-user local app for now).
- Cloud deployment.

---

**End of plan.** Each section is independently executable; owners can parallelise Part 1 (data), Part 2 (RAG), Part 3 (shell) after Week 1 Day 1 hygiene work is complete.
