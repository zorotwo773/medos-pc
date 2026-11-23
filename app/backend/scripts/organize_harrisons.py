import os
import shutil
import re

source_dir = r"E:\books\HARRISON"
dest_dir = r"E:\books\MED\Harrison's Principles of Internal Medicine"

if not os.path.exists(dest_dir):
    os.makedirs(dest_dir)

if not os.path.exists(source_dir):
    print(f"Source dir {source_dir} not found.")
    exit()

files = os.listdir(source_dir)

for file in files:
    if not file.endswith(".pdf"):
        continue
    
    src_path = os.path.join(source_dir, file)
    
    # Try to extract a part number to format with leading zeros for sorting
    new_name = file
    
    # Case 1: "Harrison's Principles of Internal Medicine - 22nd edition_Part1.pdf"
    match = re.search(r'_Part(\d+)\.pdf', file)
    if match:
        part_num = int(match.group(1))
        new_name = f"Part {part_num:02d}.pdf"
    else:
        # Case 2: "12. Endocrinology and Metabolism.pdf"
        match = re.search(r'^(\d+)\.\s+(.*)\.pdf', file)
        if match:
            part_num = int(match.group(1))
            title = match.group(2)
            new_name = f"Part {part_num:02d} - {title}.pdf"
            
    dest_path = os.path.join(dest_dir, new_name)
    
    print(f"Moving: {file} -> {new_name}")
    shutil.move(src_path, dest_path)

print("Done organizing Harrison's chapters.")
