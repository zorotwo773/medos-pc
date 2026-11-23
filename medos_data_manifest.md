# MedOS Data Manifest — Phase 0 Output

Phone target: `/sdcard/Android/data/com.sanjay.medos/files/`

## On-phone layout

```
files/
├── amboss/
│   └── amboss-2025.db              (1.37 GB) — decrypted, page_size=8192, FTS5 Search
├── uptodate/
│   ├── utdasset.sqlite             (7.67 GB) — decrypted topic_content, page_size=8192
│   ├── utdtoc.db                   (19.8 MB) — TOC, TOCMap, topics, FTS5
│   ├── fcontentsearch.db          (838 MB)  — full-content FTS5 search index
│   ├── utdqf.sqlite                (14.7 MB) — quick-find
│   ├── utd_index.sqlite             (4.1 MB) — index
│   └── unidex.en.sqlite            (93.5 MB) — unified index
├── drugs/
│   └── drug_reference.sqlite      (153 MB)  — has FTS5 (drug_fts table)
├── glossary/
│   ├── glossary.db                  (6.7 MB) — 30,738 terms, FTS5 added (glossary_fts)
│   └── concept_links.sqlite         (3.4 MB)
├── disease/
│   ├── cliniccons_disease_reference.sqlite  (2.8 MB)
│   └── reference_entities.sqlite           (35.3 MB)
├── lexi/
│   ├── 1-patch/     (331 MB) — 1_patch_f.sqlite, fcontentsearch.db, fsearch.db + fonts/images
│   ├── calc/          (4 MB) — calc.sqlite
│   ├── Cliniccons/  (289 MB) — 274_clincons.sqlite + search DBs + images
│   ├── e-TG/        (129 MB) — etgcomplete.db + images
│   ├── martindalf/  (218 MB) — 429_martindale_f.sqlite + search DBs + images
│   ├── mm/          (172 MB) — imdiMDX_DrugRef.sqlite + imdiMDX_DrugInt.sqlite
│   └── triselff/    (438 MB) — 1504_trissels.sqlite + search DBs + images
├── qbank/
│   ├── step1/
│   │   ├── uworldSTEP1-2026-march.db  (36.4 MB) — Questions, Answers, Refs, FTS5
│   │   └── *.html                     — explanation HTML files
│   └── step2/
│       ├── uworldSTEP2-2026-march.db  (48.7 MB)
│       └── *.html
├── ao/              (518 MB) — 5,695 webp images + JSON index files
└── media/
    └── amboss/      (372 MB) — 7,893 JPG images
```

## What was done in Phase 0

- **Decryption**: All DBs confirmed plain SQLite. UTD was pre-decrypted (`utdasset_decrypted.sqlite`).
- **MP4 removal**: 130 UWorld video files deleted (1.36 GB freed).
- **WAL checkpoint**: drug_reference, cliniccons_disease_reference, reference_entities — all flushed.
- **FTS5 added**: `glossary.db` now has `glossary_fts` virtual table (term + expansion + definition).
- **VACUUM + page_size=8192**: Applied to all key DBs.
- **Not included**: `books/` (13.1 GB PDFs — Phase 7), `utdasset.sqlite` (encrypted original — keep on PC only), bm25/faiss (empty), anatomy (empty, 3D deferred).

## Push command

```powershell
# Connect phone via USB with debugging enabled, then:
.\adb_push.ps1
```

## Verification queries to run after push

```sql
-- AMBOSS: FTS5 search works
SELECT title FROM Docs WHERE Docs MATCH 'atrial fibrillation' LIMIT 5;

-- UTD: topic count
SELECT COUNT(*) FROM topic_content;   -- expect 22376

-- Drug: FTS5 search
SELECT name FROM drug_fts WHERE drug_fts MATCH 'metformin' LIMIT 5;

-- Glossary: FTS5 search
SELECT term FROM glossary_fts WHERE glossary_fts MATCH 'bradycardia' LIMIT 5;
```
