/** Maps organ keyword → array of mesh name fragments that belong to it */
export const ORGAN_ALIASES: Record<string, string[]> = {
  Heart: ["heart","cardiac","ventricle","atrium","mitral","aortic","tricuspid","pulmonic","coronary","myocardium","pericardium","aorta"],
  Lung: ["lung","pulmonary","bronch","trachea","pleura","diaphragm","lobes","alveol"],
  Liver: ["liver","hepatic","bile","gallbladder","portal"],
  Kidney: ["kidney","renal","ureter","nephron","glomerulus","adrenal"],
  Brain: ["brain","cerebr","cerebellum","cortex","hippocampus","thalamus","hypothalamus","brainstem","medulla","pons","spinal cord"],
  Stomach: ["stomach","gastric","pylorus","duodenum","esophagus","oesophag"],
  Intestine: ["intestine","colon","jejunum","ileum","cecum","sigmoid","rectum"],
  Pancreas: ["pancreas","pancreatic"],
  Spleen: ["spleen","splenic"],
  Thyroid: ["thyroid","parathyroid"],
  Bladder: ["bladder","urethra","prostate"],
  Uterus: ["uterus","uterine","ovary","ovarian","fallopian","cervix","vagina"],
  Bone: ["femur","tibia","fibula","humerus","radius","ulna","vertebra","sacrum","pelvis","skull","mandible","clavicle","scapula","patella","calcaneus","rib"],
  Muscle: ["muscle","deltoid","bicep","tricep","quadricep","hamstring","gluteus","gastrocnemius","trapezius","pectoralis","latissimus"],
  Vessel: ["artery","vein","vessel","venous","arterial","carotid","jugular","subclavian","iliac","femoral artery"],
  "Blood Vessels": ["artery","vein","vessel","venous","arterial","carotid","jugular","subclavian","iliac","femoral artery"],
  Nerve: ["nerve","neural","sciatic","brachial","vagus","phrenic","femoral nerve","radial","ulnar","median nerve"],
  ENT: ["ear","nasal","sinus","pharynx","larynx","tonsil"],
};

/** Returns the organ category for a mesh name */
export function getOrganCategory(meshName: string): string | null {
  const lower = meshName.toLowerCase();
  for (const [organ, aliases] of Object.entries(ORGAN_ALIASES)) {
    if (aliases.some(a => lower.includes(a))) return organ;
  }
  return null;
}

import type { Disease } from "@/types/medical";

/** Returns diseases matching an organ category */
export function getDiseasesForMesh(
  meshName: string,
  diseases: Disease[]
): Disease[] {
  const organ = getOrganCategory(meshName);
  if (!organ) return [];
  return diseases.filter(d =>
    d.primary_organ === organ ||
    d.secondary_organs_involved.includes(organ)
  );
}
