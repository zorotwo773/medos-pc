import os
import shutil
import re

source_dir = r"E:\books"
dest_dir = r"E:\books\MED\Harrison's Principles of Internal Medicine"

files = [f for f in os.listdir(source_dir) if os.path.isfile(os.path.join(source_dir,f)) and f.endswith('.pdf') and 'harrison' in f.lower()]

for f in files:
    src_path = os.path.join(source_dir, f)
    m = re.search(r'_Part(\d+)\.pdf', f)
    if m:
        new_name = f"Part {int(m.group(1)):02d}.pdf"
    else:
        new_name = f
    dest_path = os.path.join(dest_dir, new_name)
    print(f"Moving: {f} -> {new_name}")
    shutil.move(src_path, dest_path)

print("Done.")
