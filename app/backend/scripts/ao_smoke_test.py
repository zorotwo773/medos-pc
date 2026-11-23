"""Smoke test for the AO router — exits non-zero on regression.

Run after a scrape or before deploy:

    set AO_DATA_PATH=D:\\MedOS\\data\\ao
    python app/backend/scripts/ao_smoke_test.py

Asserts that tree, mesh map, search, manifest, and a known page all return.
"""
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from routers import ao  # noqa: E402


def check(label: str, cond: bool, detail: str = "") -> bool:
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {label}{(' — ' + detail) if detail else ''}")
    return cond


def main() -> int:
    print(f"AO smoke test against {ao.AO_DATA_PATH}")
    failures = 0

    tree = ao._tree()
    if not check("tree has children", bool(tree.get("children")),
                 f"{len(tree.get('children', []))} top-level"):
        failures += 1

    mm = ao._mesh_map()
    if not check("mesh_map populated", len(mm) >= 5,
                 f"{len(mm)} terms"):
        failures += 1

    manifest = ao._manifest()
    if not check("manifest available", bool(manifest.get("page_count")),
                 f"{manifest.get('page_count')} pages"):
        failures += 1

    # Known good slug (only depends on a single proximal-humerus page being scraped)
    known = "orthopedic-trauma/adult-trauma/proximal-humerus"
    try:
        page = ao.get_page(known)
        if not check("page fetch", bool(page.get("title")), page.get("title", "")):
            failures += 1
    except Exception as exc:
        check("page fetch", False, str(exc))
        failures += 1

    # Mesh normalisation
    res = ao.get_mesh("Humerus_R")
    if not check("mesh: Humerus_R resolves", bool(res.get("slugs")),
                 f"{len(res.get('slugs', []))} slugs"):
        failures += 1

    # Search
    search_res = ao.search_pages("proximal", limit=5)
    if not check("search: 'proximal'", search_res.get("count", 0) > 0,
                 f"{search_res.get('count')} hits"):
        failures += 1

    print()
    if failures:
        print(f"FAILED — {failures} check(s) did not pass")
        return 1
    print("OK — all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
