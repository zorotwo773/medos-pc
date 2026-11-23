"""
Verify scraped AO corpus for figure distribution issues.
Run: python app/scripts/verify_scrape.py
"""
import json
import os
import sys

base = "D:/MedOS/data/ao/pages/orthopedic-trauma/adult-trauma"

if not os.path.isdir(base):
    print(f"ERROR: {base} not found. Run scraper first.")
    sys.exit(1)

issues = []
ok_count = 0
total_figs = 0

for bone in sorted(os.listdir(base)):
    bone_dir = f"{base}/{bone}"
    if not os.path.isdir(bone_dir):
        continue
    for sub in ["approach", "preparation"]:
        sub_dir = f"{bone_dir}/{sub}"
        if not os.path.isdir(sub_dir):
            continue
        for page_name in sorted(os.listdir(sub_dir)):
            idx = f"{sub_dir}/{page_name}/index.json"
            if not os.path.isfile(idx):
                continue
            try:
                data = json.loads(open(idx, encoding="utf-8").read())
            except Exception as e:
                print(f"  JSON ERROR: {bone}/{sub}/{page_name}: {e}")
                continue
            secs = data.get("sections", [])
            figs_per_sec = [len(s.get("figures", [])) for s in secs]
            total = sum(figs_per_sec)
            last = figs_per_sec[-1] if figs_per_sec else 0
            total_figs += total
            if total > 0 and last == total and len(secs) > 1:
                issues.append(f"{bone}/{sub}/{page_name}  ({total} figs all in last section)")
            else:
                ok_count += 1

print(f"Pages checked: {ok_count + len(issues)}")
print(f"Total figures: {total_figs}")
print(f"Pages OK: {ok_count}")
print(f"Pages with all-figs-in-last-section: {len(issues)}")
if issues:
    print("\nISSUES (re-scrape with --only <path> --refresh):")
    for i in issues:
        print(f"  {i}")
else:
    print("\nAll good!")
