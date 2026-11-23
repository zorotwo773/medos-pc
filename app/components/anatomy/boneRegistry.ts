import type { FC } from "react";
import type { BoneSVGProps } from "./BonePanelShared";
import AcetabulumSVG from "./svg/AcetabulumSVG";
import CarpalSVG from "./svg/CarpalSVG";
import ClavicleSVG from "./svg/ClavicleSVG";
import FemurSVG from "./svg/FemurSVG";
import FibulaSVG from "./svg/FibulaSVG";
import HumerusSVG from "./svg/HumerusSVG";
import PatellaSVG from "./svg/PatellaSVG";
import RadiusSVG from "./svg/RadiusSVG";
import ScapulaSVG from "./svg/ScapulaSVG";
import TalusSVG from "./svg/TalusSVG";
import TibiaSVG from "./svg/TibiaSVG";
import UlnaSVG from "./svg/UlnaSVG";

export interface BoneConfig {
  displayName: string;
  BoneSVG: FC<BoneSVGProps>;
  focusMeshHint: string;
}

export const BONE_REGISTRY: Record<string, BoneConfig> = {
  acetabulum: { displayName: "Acetabulum", BoneSVG: AcetabulumSVG, focusMeshHint: "Pelvis" },
  carpal: { displayName: "Carpal Bones", BoneSVG: CarpalSVG, focusMeshHint: "Carpal" },
  clavicle: { displayName: "Clavicle", BoneSVG: ClavicleSVG, focusMeshHint: "Clavicle" },
  femur: { displayName: "Femur", BoneSVG: FemurSVG, focusMeshHint: "Femur" },
  fibula: { displayName: "Fibula / Malleoli", BoneSVG: FibulaSVG, focusMeshHint: "Fibula" },
  humerus: { displayName: "Humerus", BoneSVG: HumerusSVG, focusMeshHint: "Humerus" },
  patella: { displayName: "Patella", BoneSVG: PatellaSVG, focusMeshHint: "Patella" },
  radius: { displayName: "Radius", BoneSVG: RadiusSVG, focusMeshHint: "Radius" },
  scapula: { displayName: "Scapula", BoneSVG: ScapulaSVG, focusMeshHint: "Scapula" },
  talus: { displayName: "Talus", BoneSVG: TalusSVG, focusMeshHint: "Talus" },
  tibia: { displayName: "Tibia", BoneSVG: TibiaSVG, focusMeshHint: "Tibia" },
  ulna: { displayName: "Ulna", BoneSVG: UlnaSVG, focusMeshHint: "Ulna" },
};

export function normaliseMeshToBone(cleanName: string): string | null {
  const s = cleanName.toLowerCase();

  if (
    s.includes(" muscle") ||
    s.includes(" ligament") ||
    s.includes(" tendon") ||
    s.includes("insertion") ||
    s.includes("fascia")
  ) {
    return null;
  }

  if (s.includes("humerus") || s.includes("humeral")) return "humerus";
  if (s.includes("femur") || s.includes("femoral")) return "femur";
  if (s.includes("tibia") || s.includes("tibial")) return "tibia";
  if (s.includes("patella") || s.includes("patellar")) return "patella";
  if (s.includes("scapula") || s.includes("glenoid")) return "scapula";
  if (s.includes("talus") || s.includes("talar")) return "talus";
  if (s.includes("acetabulum") || s.includes("acetabular")) return "acetabulum";
  if (s.includes("fibula") || s.includes("fibular") || s.includes("malleolus") || s.includes("malleoli")) {
    return "fibula";
  }
  if (s.includes("radius") || s.includes("radial")) return "radius";
  if (s.includes("ulna") || s.includes("ulnar")) return "ulna";
  if (s.includes("clavicle") || s.includes("clavicular")) return "clavicle";
  if (s.includes("carpus") || s.includes("carpal") || s.includes("scaphoid") || s.includes("hamate")) {
    return "carpal";
  }

  return null;
}

export function normaliseSlugToBone(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const s = slug.toLowerCase();

  if (s.includes("proximal-humerus") || s.includes("humeral-shaft") || s.includes("distal-humerus")) {
    return "humerus";
  }
  if (s.includes("proximal-femur") || s.includes("femoral-shaft") || s.includes("distal-femur")) {
    return "femur";
  }
  if (s.includes("malleoli") || s.includes("distal-tibia-fibula")) return "fibula";
  if (s.includes("proximal-tibia") || s.includes("tibial-shaft") || s.includes("distal-tibia")) {
    return "tibia";
  }
  if (s.includes("patella")) return "patella";
  if (s.includes("scapula")) return "scapula";
  if (s.includes("talus")) return "talus";
  if (s.includes("acetabulum")) return "acetabulum";
  if (s.includes("carpal-bones")) return "carpal";
  if (s.includes("clavicle")) return "clavicle";

  return null;
}

export function useBoneConfig(cleanName: string | null | undefined, slug?: string | null) {
  const boneKey = (cleanName ? normaliseMeshToBone(cleanName) : null) ?? normaliseSlugToBone(slug);
  const config = boneKey ? BONE_REGISTRY[boneKey] : null;

  if (!boneKey || !config) return null;
  return { boneKey, ...config };
}
