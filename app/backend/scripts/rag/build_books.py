"""
Build the Books FAISS + BM25 index (books_v1).

Sources: all PDFs under LIBRARY_PATH (Harrison's 22e, First Aid, etc.)
Text extraction: PyMuPDF page.get_text(); Tesseract OCR fallback for scanned pages.

Index layout:
    data/faiss/books_v1/
        index.faiss
        metadata.parquet
        bm25.pkl
        config.json

Run:
    python scripts/rag/build_books.py
    python scripts/rag/build_books.py --device cuda --batch 512
"""
from __future__ import annotations

import argparse
import json
import pickle
import re
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).parents[2]
sys.path.insert(0, str(_BACKEND))
from config import EMBED_MODEL, FAISS_DIR, LIBRARY_PATH

CHUNK_SIZE    = 512
CHUNK_OVERLAP = 64
MIN_PAGE_CHARS = 60  # below this → try OCR


def _extract_pdf(pdf: Path) -> list[dict]:
    """Extract text from a PDF, page by page, with OCR fallback."""
    try:
        import fitz
    except ImportError:
        raise SystemExit("PyMuPDF not installed. pip install pymupdf")

    doc = fitz.open(str(pdf))
    pages: list[dict] = []
    toc = doc.get_toc(simple=True)
    # Map page_number → chapter title
    chapter_map: dict[int, str] = {}
    for lvl, title, page_num in toc:
        if page_num not in chapter_map:
            chapter_map[page_num] = title

    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text = page.get_text("text").strip()

        if len(text) < MIN_PAGE_CHARS:
            # OCR fallback (requires tesseract)
            try:
                import pytesseract
                from PIL import Image
                pix = page.get_pixmap(dpi=200)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                text = pytesseract.image_to_string(img, lang="eng")
            except Exception:
                pass

        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < MIN_PAGE_CHARS:
            continue

        # Closest preceding chapter title
        section = ""
        for pn in range(page_num + 1, 0, -1):
            if pn in chapter_map:
                section = chapter_map[pn]
                break

        pages.append({
            "doc_id":  pdf.stem,
            "title":   pdf.stem,
            "section": section,
            "page":    page_num + 1,
            "text":    text,
            "source":  "books",
        })

    doc.close()
    return pages


def _chunk(pages: list[dict], chunk_size: int, overlap: int) -> list[dict]:
    try:
        from langchain.text_splitter import RecursiveCharacterTextSplitter
    except ImportError:
        raise SystemExit("langchain not installed. pip install langchain")

    splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=overlap, length_function=len)
    chunks: list[dict] = []
    for page in pages:
        for i, piece in enumerate(splitter.split_text(page["text"])):
            chunks.append({
                "chunk_id": f"{page['doc_id']}_p{page['page']}_{i}",
                "doc_id":   page["doc_id"],
                "title":    page["title"],
                "section":  page["section"],
                "page":     page["page"],
                "text":     piece,
                "source":   "books",
            })
    return chunks


def _embed_and_save(chunks: list[dict], out_dir: Path, model_name: str, device: str, batch: int) -> None:
    try:
        import numpy as np
        import faiss
        from sentence_transformers import SentenceTransformer
        import pandas as pd
        from rank_bm25 import BM25Okapi
    except ImportError as e:
        raise SystemExit(f"Missing dependency: {e}")

    out_dir.mkdir(parents=True, exist_ok=True)
    model = SentenceTransformer(model_name, device=device)
    texts = [c["text"] for c in chunks]
    n = len(texts)
    print(f"  Embedding {n:,} chunks…")

    vecs = []
    t0 = time.time()
    for i in range(0, n, batch):
        v = model.encode(texts[i:i+batch], normalize_embeddings=True, show_progress_bar=False)
        vecs.append(v)
        print(f"    {min(i+batch,n)}/{n} ({round(100*(i+batch)/n)}%)", end="\r", flush=True)
    print()

    import numpy as np
    mat = np.vstack(vecs).astype("float32")
    dim = mat.shape[1]

    index = faiss.IndexFlatIP(dim)
    index.add(mat)
    faiss.write_index(index, str(out_dir / "index.faiss"))

    df = pd.DataFrame([{k: c[k] for k in ("chunk_id","doc_id","title","section","page","source")} for c in chunks])
    df.to_parquet(out_dir / "metadata.parquet", index=False)

    bm25 = BM25Okapi([t.lower().split() for t in texts])
    with open(out_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"bm25": bm25, "texts": texts, "ids": [c["chunk_id"] for c in chunks]}, f)

    config = {
        "model": model_name, "device": device, "chunk_size": CHUNK_SIZE,
        "chunk_overlap": CHUNK_OVERLAP, "total_chunks": n, "dim": dim,
        "source": "books", "built_at": int(time.time()),
    }
    (out_dir / "config.json").write_text(json.dumps(config, indent=2))
    print(f"  Saved → {out_dir}  ({index.ntotal} vectors, dim={dim})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Books FAISS+BM25 index")
    parser.add_argument("--model",  default=EMBED_MODEL)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--batch",  type=int, default=256)
    parser.add_argument("--out",    default=str(FAISS_DIR / "books_v1"))
    parser.add_argument("--library", default=str(LIBRARY_PATH))
    args = parser.parse_args()

    library = Path(args.library)
    if not library.exists():
        raise SystemExit(f"Library path does not exist: {library}")

    pdfs = sorted(library.rglob("*.pdf"))
    pdfs = [p for p in pdfs if "_thumbs" not in p.parts]
    print(f"=== MedOS Books index builder ===")
    print(f"Found {len(pdfs)} PDFs in {library}")

    all_pages: list[dict] = []
    for i, pdf in enumerate(pdfs, 1):
        print(f"  [{i}/{len(pdfs)}] Extracting {pdf.name}…")
        try:
            all_pages.extend(_extract_pdf(pdf))
        except Exception as e:
            print(f"    ERROR: {e}")

    print(f"\nExtracted {len(all_pages):,} pages")
    chunks = _chunk(all_pages, CHUNK_SIZE, CHUNK_OVERLAP)
    print(f"Chunked into {len(chunks):,} pieces")

    _embed_and_save(chunks, Path(args.out), args.model, args.device, args.batch)
    print("All done.")


if __name__ == "__main__":
    main()
