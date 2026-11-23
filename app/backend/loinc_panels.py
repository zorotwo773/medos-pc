"""Curated common clinical lab panels with LOINC codes + adult reference ranges.

Reference ranges are conservative defaults for adult males/females; clinical
context (pregnancy, age, lab assay) can shift them. The frontend should show
"local lab range applies" disclaimer.

LOINC codes verified against UMLS umls_codes(sab='LNC').
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Sequence


@dataclass(frozen=True)
class LabRef:
    loinc: str
    display: str
    units: str = ""
    ref_low: str = ""
    ref_high: str = ""
    note: str = ""


@dataclass(frozen=True)
class LabPanel:
    id: str
    name: str
    description: str
    codes: Sequence[LabRef]


# Reference ranges from common adult internal-medicine sources (UpToDate / Tintinalli
# baseline). For Hb / WBC: 70 kg adult, non-pregnant.

PANELS: tuple[LabPanel, ...] = (
    LabPanel(
        id="cbc",
        name="Complete Blood Count (CBC)",
        description="Hemoglobin, hematocrit, RBC, WBC, platelets with red-cell indices",
        codes=(
            LabRef("718-7",   "Hemoglobin",                "g/dL",  "12.0 (F) / 13.5 (M)", "16.0 (F) / 17.5 (M)"),
            LabRef("4544-3",  "Hematocrit",                "%",     "36 (F) / 41 (M)",     "46 (F) / 53 (M)"),
            LabRef("789-8",   "RBC count",                 "10^6/µL","4.2 (F)",            "5.4 (M)"),
            LabRef("6690-2",  "WBC count",                 "10^3/µL","4.0",                "11.0"),
            LabRef("777-3",   "Platelets",                 "10^3/µL","150",                "400"),
            LabRef("787-2",   "MCV (mean cell volume)",    "fL",    "80",                  "100"),
            LabRef("785-6",   "MCH",                       "pg",    "27",                  "33"),
            LabRef("786-4",   "MCHC",                      "g/dL",  "32",                  "36"),
            LabRef("788-0",   "RDW",                       "%",     "11.5",                "14.5"),
        ),
    ),
    LabPanel(
        id="diff",
        name="WBC Differential",
        description="Absolute and relative leukocyte counts",
        codes=(
            LabRef("751-8",   "Neutrophils (absolute)",    "10^3/µL","2.0",                "7.5"),
            LabRef("731-0",   "Lymphocytes (absolute)",    "10^3/µL","1.0",                "4.0"),
            LabRef("742-7",   "Monocytes (absolute)",      "10^3/µL","0.2",                "1.0"),
            LabRef("711-2",   "Eosinophils (absolute)",    "10^3/µL","0.04",               "0.5"),
            LabRef("704-7",   "Basophils (absolute)",      "10^3/µL","0",                  "0.1"),
        ),
    ),
    LabPanel(
        id="bmp",
        name="Basic Metabolic Panel (BMP)",
        description="Electrolytes, BUN, creatinine, glucose",
        codes=(
            LabRef("2951-2",  "Sodium",                    "mmol/L","135",                 "145"),
            LabRef("2823-3",  "Potassium",                 "mmol/L","3.5",                 "5.0"),
            LabRef("2075-0",  "Chloride",                  "mmol/L","98",                  "107"),
            LabRef("2028-9",  "Bicarbonate (CO2 total)",   "mmol/L","22",                  "29"),
            LabRef("3094-0",  "BUN",                       "mg/dL", "7",                   "20"),
            LabRef("2160-0",  "Creatinine (serum)",        "mg/dL", "0.6 (F) / 0.7 (M)",   "1.1 (F) / 1.3 (M)"),
            LabRef("2345-7",  "Glucose",                   "mg/dL", "70",                  "99 (fasting)"),
            LabRef("17861-6", "Calcium (total)",           "mg/dL", "8.5",                 "10.2"),
            LabRef("33037-3", "Anion gap",                 "mmol/L","3",                   "11"),
        ),
    ),
    LabPanel(
        id="cmp",
        name="Comprehensive Metabolic Panel (CMP)",
        description="BMP + liver function tests + protein/albumin",
        codes=(
            LabRef("2951-2",  "Sodium",                    "mmol/L","135", "145"),
            LabRef("2823-3",  "Potassium",                 "mmol/L","3.5", "5.0"),
            LabRef("2075-0",  "Chloride",                  "mmol/L","98",  "107"),
            LabRef("2028-9",  "Bicarbonate",               "mmol/L","22",  "29"),
            LabRef("3094-0",  "BUN",                       "mg/dL", "7",   "20"),
            LabRef("2160-0",  "Creatinine",                "mg/dL", "0.6", "1.3"),
            LabRef("2345-7",  "Glucose",                   "mg/dL", "70",  "99"),
            LabRef("17861-6", "Calcium",                   "mg/dL", "8.5", "10.2"),
            LabRef("2885-2",  "Total protein",             "g/dL",  "6.0", "8.3"),
            LabRef("1751-7",  "Albumin",                   "g/dL",  "3.5", "5.0"),
            LabRef("1975-2",  "Bilirubin (total)",         "mg/dL", "0.1", "1.2"),
            LabRef("1742-6",  "ALT",                       "U/L",   "7",   "55"),
            LabRef("1920-8",  "AST",                       "U/L",   "8",   "48"),
            LabRef("6768-6",  "Alkaline phosphatase",      "U/L",   "40",  "129"),
        ),
    ),
    LabPanel(
        id="lfts",
        name="Liver Function Tests (LFTs)",
        description="Transaminases, alk phos, bilirubin, albumin",
        codes=(
            LabRef("1742-6",  "ALT",                       "U/L",   "7",    "55"),
            LabRef("1920-8",  "AST",                       "U/L",   "8",    "48"),
            LabRef("6768-6",  "Alkaline phosphatase",      "U/L",   "40",   "129"),
            LabRef("1975-2",  "Bilirubin (total)",         "mg/dL", "0.1",  "1.2"),
            LabRef("1968-7",  "Bilirubin (direct)",        "mg/dL", "0.0",  "0.3"),
            LabRef("1971-1",  "Bilirubin (indirect)",      "mg/dL", "0.0",  "0.9"),
            LabRef("1751-7",  "Albumin",                   "g/dL",  "3.5",  "5.0"),
            LabRef("2885-2",  "Total protein",             "g/dL",  "6.0",  "8.3"),
            LabRef("2324-2",  "GGT",                       "U/L",   "9",    "48"),
        ),
    ),
    LabPanel(
        id="lipid",
        name="Lipid Panel",
        description="Total cholesterol, HDL, LDL, triglycerides",
        codes=(
            LabRef("2093-3",  "Cholesterol (total)",       "mg/dL", "",     "200 (desirable)"),
            LabRef("2085-9",  "HDL cholesterol",           "mg/dL", "40 (M) / 50 (F)", "—"),
            LabRef("13457-7", "LDL cholesterol (calc)",    "mg/dL", "",     "100 (optimal)"),
            LabRef("2571-8",  "Triglycerides",             "mg/dL", "",     "150 (fasting)"),
            LabRef("9830-1",  "Cholesterol/HDL ratio",     "ratio", "",     "5.0"),
        ),
    ),
    LabPanel(
        id="coag",
        name="Coagulation Studies",
        description="PT/INR, aPTT, fibrinogen, D-dimer",
        codes=(
            LabRef("5902-2",  "Prothrombin time (PT)",     "sec",   "11",   "13.5"),
            LabRef("6301-6",  "INR",                       "",      "0.8",  "1.2"),
            LabRef("3173-2",  "aPTT",                      "sec",   "25",   "35"),
            LabRef("3255-7",  "Fibrinogen",                "mg/dL", "200",  "400"),
            LabRef("48065-7", "D-dimer (FEU)",             "ng/mL", "",     "500"),
        ),
    ),
    LabPanel(
        id="abg",
        name="Arterial Blood Gas (ABG)",
        description="pH, pCO2, pO2, bicarbonate, base excess, lactate",
        codes=(
            LabRef("2744-1",  "pH (arterial)",             "",      "7.35", "7.45"),
            LabRef("2019-8",  "pCO2 (arterial)",           "mmHg",  "35",   "45"),
            LabRef("2703-7",  "pO2 (arterial)",            "mmHg",  "80",   "100"),
            LabRef("1959-6",  "Bicarbonate (calc)",        "mmol/L","22",   "26"),
            LabRef("1925-7",  "Base excess",               "mmol/L","-2",   "+2"),
            LabRef("2518-9",  "O2 saturation",             "%",     "95",   "100"),
            LabRef("2524-7",  "Lactate (venous)",          "mmol/L","0.5",  "2.2"),
        ),
    ),
    LabPanel(
        id="thyroid",
        name="Thyroid Function",
        description="TSH, free T4, free T3",
        codes=(
            LabRef("3016-3",  "TSH",                       "mIU/L", "0.4",  "4.0"),
            LabRef("3024-7",  "Free T4",                   "ng/dL", "0.8",  "1.8"),
            LabRef("3051-0",  "Free T3",                   "pg/mL", "2.3",  "4.2"),
            LabRef("3026-2",  "Total T4",                  "µg/dL", "5.0",  "12.0"),
        ),
    ),
    LabPanel(
        id="iron",
        name="Iron Studies",
        description="Iron, TIBC, ferritin, transferrin saturation",
        codes=(
            LabRef("2498-4",  "Iron (serum)",              "µg/dL", "60 (F) / 80 (M)", "170"),
            LabRef("2500-7",  "TIBC",                      "µg/dL", "240",   "450"),
            LabRef("2276-4",  "Ferritin",                  "ng/mL", "15 (F) / 30 (M)", "300"),
            LabRef("2502-3",  "Transferrin saturation",    "%",     "20",    "50"),
        ),
    ),
    LabPanel(
        id="cardiac",
        name="Cardiac Markers",
        description="Troponins, BNP, CK-MB",
        codes=(
            LabRef("10839-9", "Troponin I (cTnI)",         "ng/mL", "",      "0.04 (99th %ile, varies)"),
            LabRef("6598-7",  "Troponin T",                "ng/mL", "",      "0.01"),
            LabRef("33762-6", "NT-proBNP",                 "pg/mL", "",      "125 (age <75)"),
            LabRef("30934-4", "BNP",                       "pg/mL", "",      "100"),
            LabRef("13969-1", "CK-MB",                     "ng/mL", "",      "6.3"),
        ),
    ),
    LabPanel(
        id="ua",
        name="Urinalysis",
        description="Common dipstick + microscopy values",
        codes=(
            LabRef("5811-5",  "Specific gravity",          "",      "1.005", "1.030"),
            LabRef("5803-2",  "pH (urine)",                "",      "4.5",   "8.0"),
            LabRef("5804-0",  "Protein (urine)",           "mg/dL", "",      "Negative / trace"),
            LabRef("5792-7",  "Glucose (urine)",           "",      "",      "Negative"),
            LabRef("5797-6",  "Ketones",                   "",      "",      "Negative"),
            LabRef("5802-4",  "Nitrite",                   "",      "",      "Negative"),
            LabRef("5799-2",  "Leukocyte esterase",        "",      "",      "Negative"),
            LabRef("5794-3",  "Hemoglobin (urine)",        "",      "",      "Negative"),
        ),
    ),
)


def panel_summary() -> list[dict]:
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "codes": [asdict(c) for c in p.codes],
        }
        for p in PANELS
    ]


def find_panel(panel_id: str) -> LabPanel | None:
    for panel in PANELS:
        if panel.id == panel_id:
            return panel
    return None
