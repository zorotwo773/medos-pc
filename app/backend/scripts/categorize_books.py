import os
import shutil

lib_dir = r"E:\books\MED"

categories = {
    "Anatomy": ["anatomy", "netter", "grays"],
    "Physiology": ["physiology", "guyton"],
    "Biochemistry": ["biochem", "lehninger", "harper"],
    "Pathology": ["pathology", "robbins", "virchow"],
    "Pharmacology": ["pharma", "goodman", "katzung"],
    "Microbiology": ["micro", "immune"],
    "Internal Medicine": ["medicine", "davidson", "bates", "washington", "current medical"],
    "Surgery": ["surgery", "sabiston", "bailey", "zollinger", "operative"],
    "Obstetrics & Gynecology": ["obgy", "obstetric", "gynecology", "williams", "dutta", "shaws"],
    "Pediatrics": ["pediatric", "nelson"],
    "Neurology": ["neuro", "adams", "brain", "eeg"],
    "Psychiatry": ["psychiatr", "dsm"],
    "Orthopedics": ["ortho", "bone"],
    "Emergency Medicine": ["emergency", "tintinalli", "critical care", "disaster"],
    "Cardiology": ["heart", "cardio", "ecg"],
    "USMLE": ["usmle", "first aid", "boards"]
}

for file in os.listdir(lib_dir):
    src = os.path.join(lib_dir, file)
    if not os.path.isfile(src) or not file.lower().endswith(".pdf"):
        continue

    assigned_cat = "Miscellaneous"
    lower_name = file.lower()
    
    # Simple matching
    for cat, keywords in categories.items():
        if any(kw in lower_name for kw in keywords):
            assigned_cat = cat
            break
            
    cat_dir = os.path.join(lib_dir, assigned_cat)
    os.makedirs(cat_dir, exist_ok=True)
    
    dest = os.path.join(cat_dir, file)
    try:
        shutil.move(src, dest)
    except Exception as e:
        pass

print("Categorization complete.")
