export const ORGAN_ALIASES: Record<string, string[]> = {
  // ── Cardiovascular ──────────────────────────────────────────
  "Heart":         ["heart", "ventricle", "atrium", "mitral", "tricuspid", "aortic valve", "pulmonary valve", "septum", "myocardium", "pericardium", "endocardium", "coronary"],
  "Aorta":         ["aorta", "aortic"],
  "Carotid":       ["carotid"],
  "Femoral Vein":  ["femoral vein", "femoral"],
  "Blood Vessels": ["artery", "arterial", "vein", "venous", "vessel", "vascular", "aorta", "carotid", "femoral"],

  // ── Pulmonary ────────────────────────────────────────────────
  "Lung":          ["lung", "pulmonary", "bronch", "lobe", "alveol", "trachea"],
  "Pleura":        ["pleura", "pleural"],
  "Diaphragm":     ["diaphragm"],

  // ── Gastrointestinal / Hepatic ──────────────────────────────
  "Liver":         ["liver", "hepat", "hepatic"],
  "Pancreas":      ["pancreas", "pancreatic"],
  "Esophagus":     ["esophag", "oesophag"],
  "Stomach":       ["stomach", "gastric", "pylorus", "duodenum"],
  "Intestine":     ["intestine", "intestinal", "colon", "rectum", "ileum", "cecum", "sigmoid"],
  "Spleen":        ["spleen", "splenic"],

  // ── Renal / Urinary ─────────────────────────────────────────
  "Kidney":        ["kidney", "renal", "nephro", "ureter", "adrenal"],
  "Bladder":       ["bladder", "urethra", "prostate"],
  "Adrenal":       ["adrenal"],

  // ── Neurological ────────────────────────────────────────────
  "Brain":         ["brain", "cerebr", "cerebellum", "cortex", "hippocampus", "thalamus", "hypothalamus", "brainstem", "pons", "medulla oblongata"],
  "Nerves":        ["nerve", "neural", "ganglion", "plexus", "spinal cord"],

  // ── Sensory ─────────────────────────────────────────────────
  "Eye":           ["eye", "orbit", "retina", "optic", "sclera", "cornea", "lens", "ocular"],
  "ENT":           ["ear", "nasal", "sinus", "pharynx", "larynx", "tonsil"],

  // ── Musculoskeletal ─────────────────────────────────────────
  "Bone":          ["bone", "femur", "tibia", "humerus", "vertebr", "rib", "sternum", "clavicle", "scapula", "pelvis", "sacrum", "patella"],
  "Muscle":        ["muscle", "tendon", "ligament", "fascia"],
  "Uterus":        ["uterus", "uterine", "ovary", "ovarian", "cervix", "vagina"],
}

export function meshMatchesOrgan(cleanMeshName: string, organLabel: string): boolean {
  if (!cleanMeshName || !organLabel) return false
  const mesh  = cleanMeshName.toLowerCase()
  const organ = organLabel.toLowerCase()
  if (mesh.includes(organ) || organ.includes(mesh)) return true
  const aliases = ORGAN_ALIASES[organLabel]
  if (!aliases) return mesh.includes(organ)
  return aliases.some((alias) => mesh.includes(alias))
}
