"use client";
import { useRef, useState, useEffect, Suspense, useCallback } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { useDarkMode } from "@/components/common/useDarkMode";
import { meshMatchesOrgan } from "./organAliases";

// scaleMultiplier: 100 = metres export, 1 = centimetres export (Z-Anatomy)
export const LAYERS = [
  { id: "skeletal",       file: "/models/skeletal.glb",       color: "#adb5bd", label: "Skeletal",       emoji: "🦴", scaleMultiplier: 100 },
  { id: "muscular",       file: "/models/muscular.glb",       color: "#e07b54", label: "Muscular",       emoji: "💪", scaleMultiplier: 1   },
  { id: "cardiovascular", file: "/models/cardiovascular.glb", color: "#e63946", label: "Cardiovascular", emoji: "❤️", scaleMultiplier: 1   },
  { id: "visceral",       file: "/models/visceral.glb",       color: "#4cc9f0", label: "Visceral",       emoji: "🫁", scaleMultiplier: 100 },
  { id: "nervous",        file: "/models/nervous.glb",        color: "#9b5de5", label: "Nervous",        emoji: "🧠", scaleMultiplier: 100 },
  { id: "joints",         file: "/models/joints.glb",         color: "#f9c74f", label: "Joints",         emoji: "🔗", scaleMultiplier: 1   },
  { id: "lymphoid",       file: "/models/lymphoid.glb",       color: "#2dc653", label: "Lymphoid",       emoji: "🛡️", scaleMultiplier: 100 },
];

interface SharedTransform { s: number; px: number; py: number; pz: number }
export interface MeshInfo { name: string; cleanName: string }
export interface HighlightState { primaryOrgan: string; secondaryOrgans: string[] }
export interface CrossSection { enabled: boolean; axis: "x" | "y" | "z"; position: number; flip: boolean }

export function cleanName(raw: string): string {
  let cleaned = raw
    .replace(/^(AnyConv\.com__|Group_\d+_|Object_\d+_)/gi, "")
    .replace(/_D$/i, " (Right)").replace(/_G$/i, " (Left)")
    .replace(/_R$/i, " (Right)").replace(/_L$/i, " (Left)")
    .replace(/[_-]?\d+$/g, "")
    .replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : raw;
}

// Keywords that identify muscle-attachment-site marker meshes in the skeletal layer.
// These overlay on bone surfaces and block click-through to the actual bone.
const MUSCLE_KW = [
  // Shoulder / arm
  "deltoid","bicep","tricep","pector","latissim",
  "supraspinatus","infraspinatus","teres minor","teres major","subscapular",
  "brachialis","brachioradialis","pronator","supinator","coracobrachialis",
  // Hip / thigh
  "gluteus","gluteal","iliacus","iliopsoas","psoas","piriformis",
  "obturator","gemellus","quadratus femoris",
  "vastus","rectus femoris","rectus fem",
  "adductor","pectineus","gracilis","sartorius","tensor fasciae","tfl",
  "semimembran","semitend","biceps femoris",
  "hamstring","quadricep",
  // Knee / leg
  "gastrocnem","soleus","popliteus","plantaris",
  "tibialis","peroneus","fibularis",
  // Trunk / spine
  "trapezius","rhomboid","serratus",
  "sternocleidomastoid","scalene","splenius","levator scap","erector",
  "multifidus","semispinalis",
  // Hand / foot
  "interosseus","lumbrical","thenar","hypothenar",
];

const SKELETAL_OVERLAY_KW = [
  " muscle",
  " muscles",
  " ligament",
  " tendon",
  "insertion",
  "aponeurosis",
  "retinaculum",
  "fascia",
];

export function isAttachmentSiteMesh(cleanedName: string): boolean {
  const n = cleanedName.toLowerCase();
  return SKELETAL_OVERLAY_KW.some(kw => n.includes(kw)) || MUSCLE_KW.some(kw => n.includes(kw));
}

interface ThreePointerEventLike {
  object?: THREE.Object3D;
  intersections?: { object: THREE.Object3D }[];
}

function selectableMeshFromEvent(e: ThreePointerEventLike, boneOnlyMode: boolean | undefined, layerId: string): THREE.Mesh | null {
  const candidates = Array.isArray(e.intersections) && e.intersections.length
    ? e.intersections.map(hit => hit.object as THREE.Mesh)
    : [e.object as THREE.Mesh];

  for (const mesh of candidates) {
    if (!mesh?.isMesh || !mesh.name) continue;
    const isSuppressedOverlay = boneOnlyMode && layerId === "skeletal" && isAttachmentSiteMesh(cleanName(mesh.name));
    if (!isSuppressedOverlay) return mesh;
  }

  return null;
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | undefined) {
  if (Array.isArray(material)) {
    material.forEach(m => m.dispose());
    return;
  }
  material?.dispose();
}

function disposeTrackedMaterials(materials: Set<THREE.Material>) {
  materials.forEach(material => material.dispose());
  materials.clear();
}

function clearLayerModelCache(file: string) {
  (useGLTF as unknown as { clear?: (url: string) => void }).clear?.(file);
}

const CAM_PRESETS: Record<string, [number, number, number]> = {
  anterior:  [0,  0.85,  2.8],
  posterior: [0,  0.85, -2.8],
  left:      [-2.8, 0.85, 0],
  right:     [2.8,  0.85, 0],
  superior:  [0,  3.5,  0.01],
  inferior:  [0, -2,    0.01],
};

// ─── Single layer ──────────────────────────────────────────────────────────
function LayerModel({
  layer, visible, isBase, sharedScale, onBaseScale,
  selectedName, onSelect, highlightState, hiddenMeshes, onMeshesLoaded, clickable,
  boneOnlyMode,
}: {
  layer: typeof LAYERS[number];
  visible: boolean;
  isBase: boolean;
  sharedScale: SharedTransform | null;
  onBaseScale?: (t: SharedTransform) => void;
  selectedName: string | null;
  onSelect: (name: string, pos: THREE.Vector3) => void;
  highlightState: HighlightState | null;
  hiddenMeshes: Set<string>;
  onMeshesLoaded?: (layerId: string, meshes: MeshInfo[]) => void;
  clickable?: boolean;
  boneOnlyMode?: boolean;
}) {
  const { scene } = useGLTF(layer.file);
  const applied = useRef(false);
  const selectionOutlineRef = useRef<{ parent: THREE.Object3D; outline: THREE.Mesh }[]>([]);
  const originalMaterials = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>());
  const sourceMaterials = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>());
  const ownedMaterials = useRef(new Set<THREE.Material>());
  const highlightMaterials = useRef(new Set<THREE.Material>());

  useEffect(() => () => {
    selectionOutlineRef.current.forEach(({ parent, outline }) => {
      parent.remove(outline);
      disposeMaterial(outline.material);
    });
    selectionOutlineRef.current.length = 0;
    originalMaterials.current.forEach((origMat, mesh) => { mesh.material = origMat; });
    originalMaterials.current.clear();
    sourceMaterials.current.forEach((origMat, mesh) => { mesh.material = origMat; });
    sourceMaterials.current.clear();
    disposeTrackedMaterials(highlightMaterials.current);
    disposeTrackedMaterials(ownedMaterials.current);
    scene.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    clearLayerModelCache(layer.file);
  }, [scene, layer.file]);

  // One-time: hide annotation lines
  useEffect(() => {
    scene.traverse((child) => {
      if (
        (child as any).isLine || (child as any).isLineSegments || (child as any).isLineLoop ||
        child.type === "Line" || child.type === "LineSegments" || child.type === "LineLoop"
      ) child.visible = false;
    });
  }, [scene]);

  // One-time transform + coloring setup
  useEffect(() => {
    if (applied.current) return;
    if (!isBase && !sharedScale) return;
    applied.current = true;

    const baseMult = layer.scaleMultiplier || 1;

    if (isBase) {
      scene.position.set(0, 0, 0);
      scene.scale.setScalar(baseMult);
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const h = box.max.y - box.min.y;
      const s = 1.45 / Math.max(h, 0.001);
      scene.scale.setScalar(baseMult * s);
      scene.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(scene);
      const c = new THREE.Vector3();
      box2.getCenter(c);
      const px = -c.x, py = -box2.min.y, pz = -c.z;
      scene.position.set(px, py, pz);
      onBaseScale?.({ s, px, py, pz });
    } else {
      scene.scale.setScalar(baseMult * sharedScale!.s);
      scene.position.set(sharedScale!.px, sharedScale!.py, sharedScale!.pz);
    }

    // Thematic coloring
    scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || !child.name) return;
      const mesh = child as THREE.Mesh;
      const mat = new THREE.MeshStandardMaterial();
      if (!sourceMaterials.current.has(mesh)) sourceMaterials.current.set(mesh, mesh.material);
      ownedMaterials.current.add(mat);
      const name = child.name.toLowerCase();
      const isVisceral = layer.id === "visceral" || layer.id === "muscular";

      if (name.includes("vein") || name.includes("venous") || name.includes("vena"))
        mat.color = new THREE.Color("#3b82f6");
      else if (name.includes("artery") || name.includes("arterial") || name.includes("aorta"))
        mat.color = new THREE.Color("#ef4444");
      else if (name.includes("nerve") || name.includes("ganglion") || name.includes("plexus"))
        mat.color = new THREE.Color("#fbbf24");
      else if (name.includes("lymph") || name.includes("node") || name.includes("duct"))
        mat.color = new THREE.Color("#2dc653");
      else if (name.includes("bone") || name.includes("tooth") || name.includes("cartilage") || layer.id === "skeletal")
        mat.color = new THREE.Color("#f1f5f9");
      else if (isVisceral) {
        const base = child.name.toLowerCase()
          .replace(/ \((right|left|l|r)\)$/gi, "")
          .replace(/_(d|g|l|r)$/gi, "").replace(/(_\d+)$/gi, "").trim();
        const hStr = layer.id === "muscular" ? base + "muscle" : base;
        let hash = 0;
        for (let i = 0; i < hStr.length; i++) hash = hStr.charCodeAt(i) + ((hash << 5) - hash);
        mat.color.setHSL((Math.abs(hash) % 360) / 360,
          layer.id === "muscular" ? 0.65 : 0.85,
          layer.id === "muscular" ? 0.35 : 0.65);
      } else if (layer.id === "nervous")
        mat.color = new THREE.Color("#e2e8f0");
      else
        mat.color = new THREE.Color(layer.color);

      mat.roughness = (layer.id === "skeletal" || name.includes("bone")) ? 0.6 : 0.35;
      mat.metalness = 0.05;
      mat.side = THREE.DoubleSide;
      mesh.material = mat;
    });

    const meshes: MeshInfo[] = [];
    const seen = new Set<string>();
    scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.name && !seen.has(child.name)) {
        seen.add(child.name);
        meshes.push({ name: child.name, cleanName: cleanName(child.name) });
      }
    });
    meshes.sort((a, b) => a.cleanName.localeCompare(b.cleanName));
    onMeshesLoaded?.(layer.id, meshes);
  }, [scene, layer, isBase, sharedScale, onBaseScale, onMeshesLoaded]);

  // Per-mesh visibility + raycast disable for hidden meshes + bone-only attachment suppression
  useEffect(() => {
    if (!hiddenMeshes) return;
    scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || !child.name) return;
      const cn = cleanName(child.name);
      // boneOnlyMode: hide muscle-attachment markers on the skeletal layer
      const isAttachment = boneOnlyMode && layer.id === "skeletal" && isAttachmentSiteMesh(cn);
      const hide = hiddenMeshes.has(cn) || isAttachment;
      child.visible = !hide;
      if (hide) {
        if (!(child as any)._origRaycast) (child as any)._origRaycast = (child as THREE.Mesh).raycast.bind(child);
        (child as THREE.Mesh).raycast = () => {};
      } else if ((child as any)._origRaycast) {
        (child as THREE.Mesh).raycast = (child as any)._origRaycast;
        delete (child as any)._origRaycast;
      }
    });
  }, [scene, hiddenMeshes, boneOnlyMode, layer.id]);

  // Disable raycasting on the entire layer when clickable=false (e.g. joints in ortho mode)
  useEffect(() => {
    if (clickable === false) {
      scene.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        if (!(child as any)._origRaycastClickable) {
          (child as any)._origRaycastClickable = mesh.raycast.bind(mesh);
        }
        mesh.raycast = () => {};
      });
    } else {
      scene.traverse((child) => {
        if (!(child as any)._origRaycastClickable) return;
        const mesh = child as THREE.Mesh;
        mesh.raycast = (child as any)._origRaycastClickable;
        delete (child as any)._origRaycastClickable;
      });
    }
  }, [scene, clickable]);

  // Selection outline — gold BackSide silhouette (from Living Textbook)
  useEffect(() => {
    const refs = selectionOutlineRef.current;
    refs.forEach(({ parent, outline }) => {
      parent.remove(outline);
      outline.material instanceof THREE.Material && outline.material.dispose();
    });
    refs.length = 0;

    if (!selectedName) return;

    scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || !child.name) return;
      if (cleanName(child.name) !== selectedName) return;
      const outline = new THREE.Mesh(
        (child as THREE.Mesh).geometry,
        new THREE.MeshBasicMaterial({ color: 0xffd700, side: THREE.BackSide, transparent: true, opacity: 0.88 })
      );
      outline.scale.setScalar(1.07);
      outline.renderOrder = 1;
      child.add(outline);
      refs.push({ parent: child, outline });
    });

    return () => {
      refs.forEach(({ parent, outline }) => {
        parent.remove(outline);
        outline.material instanceof THREE.Material && outline.material.dispose();
      });
      refs.length = 0;
    };
  }, [scene, selectedName]);

  // Systemic Ghosting Effect (from Living Textbook)
  useEffect(() => {
    const origMap = originalMaterials.current;

    if (!highlightState) {
      origMap.forEach((origMat, mesh) => { mesh.material = origMat as THREE.Material; });
      origMap.clear();
      disposeTrackedMaterials(highlightMaterials.current);
      return;
    }

    const { primaryOrgan, secondaryOrgans } = highlightState;

    scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh || !child.name) return;
      const mesh = child as THREE.Mesh;

      if (!origMap.has(mesh)) origMap.set(mesh, mesh.material);

      const name = cleanName(child.name);
      const isPrimary   = meshMatchesOrgan(name, primaryOrgan);
      const isSecondary = !isPrimary && secondaryOrgans.some((org) => meshMatchesOrgan(name, org));

      if (isPrimary) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        highlightMaterials.current.add(mat);
        mat.color = new THREE.Color(0.7, 0.08, 0.08);
        mat.emissive = new THREE.Color(0.4, 0.02, 0.02);
        mat.emissiveIntensity = 0.6;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
        mesh.material = mat;
      } else if (isSecondary) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        highlightMaterials.current.add(mat);
        mat.color = new THREE.Color(0.9, 0.55, 0.1);
        mat.emissive = new THREE.Color(0.3, 0.15, 0.0);
        mat.emissiveIntensity = 0.5;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
        mesh.material = mat;
      } else {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        highlightMaterials.current.add(mat);
        mat.transparent = true;
        mat.opacity = 0.15;
        mat.depthWrite = false;
        mat.color = new THREE.Color(0.7, 0.75, 0.8);
        mat.emissive = new THREE.Color(0, 0, 0);
        mat.emissiveIntensity = 0;
        mesh.material = mat;
      }
    });

    return () => {
      origMap.forEach((origMat, mesh) => { mesh.material = origMat as THREE.Material; });
      origMap.clear();
      disposeTrackedMaterials(highlightMaterials.current);
    };
  }, [scene, highlightState]);

  return (
    <primitive
      object={scene}
      visible={visible}
      onClick={clickable === false ? undefined : (e: any) => {
        e.stopPropagation();
        const m = selectableMeshFromEvent(e, boneOnlyMode, layer.id);
        if (m?.isMesh) onSelect(cleanName(m.name || m.uuid), e.point);
      }}
      onPointerOver={clickable === false ? undefined : (e: any) => {
        e.stopPropagation();
        const m = selectableMeshFromEvent(e, boneOnlyMode, layer.id);
        if (!m) return;
        document.body.style.cursor = "pointer";
        if (m.isMesh && m.material && !highlightState) {
          (m.material as THREE.MeshStandardMaterial).emissive?.setHex(0x334155);
        }
      }}
      onPointerOut={clickable === false ? undefined : (e: any) => {
        document.body.style.cursor = "default";
        const m = selectableMeshFromEvent(e, boneOnlyMode, layer.id);
        if (!m) return;
        if (m.isMesh && m.material && !highlightState) {
          const mat = m.material as THREE.MeshStandardMaterial;
          if (cleanName(m.name) === selectedName) mat.emissive?.setHex(0x3182ce);
          else mat.emissive?.setHex(0x000000);
        }
      }}
    />
  );
}

// ─── Clipping plane controller ────────────────────────────────────────────
function ClipPlaneController({ crossSection }: { crossSection: CrossSection | null }) {
  const { gl } = useThree();

  useEffect(() => {
    if (!crossSection?.enabled) {
      gl.clippingPlanes = [];
      return;
    }
    const { axis, position, flip } = crossSection;
    const nx = axis === "x" ? (flip ? 1 : -1) : 0;
    const ny = axis === "y" ? (flip ? 1 : -1) : 0;
    const nz = axis === "z" ? (flip ? 1 : -1) : 0;
    const constant = flip ? -position : position;
    gl.clippingPlanes = [new THREE.Plane(new THREE.Vector3(nx, ny, nz), constant)];
    return () => { gl.clippingPlanes = []; };
  }, [crossSection, gl]);

  return null;
}

// ─── Visual cut plane indicator ───────────────────────────────────────────
function ClipPlaneVisual({ crossSection }: { crossSection: CrossSection }) {
  const { axis, position } = crossSection;
  const pos = axis === "x" ? [position, 0.85, 0] as [number,number,number]
            : axis === "y" ? [0, position, 0]    as [number,number,number]
            : [0, 0.85, position]                as [number,number,number];
  const rot = axis === "x" ? [0, Math.PI / 2, 0] as [number,number,number]
            : axis === "y" ? [-Math.PI / 2, 0, 0] as [number,number,number]
            : [0, 0, 0]                           as [number,number,number];
  return (
    <mesh position={pos} rotation={rot} renderOrder={999}>
      <planeGeometry args={[3, 3]} />
      <meshBasicMaterial color="#3182ce" opacity={0.18} transparent side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

// ─── Viewport controller ──────────────────────────────────────────────────
function ViewportController({
  preset, focusMesh, resetSeq,
}: {
  preset: string | null;
  focusMesh: { name: string; seq: number } | null;
  resetSeq: number;
}) {
  const { camera, controls, scene } = useThree();

  useEffect(() => {
    if (!preset || !CAM_PRESETS[preset]) return;
    const [x, y, z] = CAM_PRESETS[preset];
    camera.position.set(x, y, z);
    camera.lookAt(0, 0.85, 0);
    if (controls) { (controls as any).target.set(0, 0.85, 0); (controls as any).update(); }
  }, [preset, camera, controls]);

  useEffect(() => {
    if (!focusMesh?.name) return;
    let target: THREE.Object3D | null = null;
    scene.traverse((c) => { if ((c as THREE.Mesh).isMesh && c.name === focusMesh.name && !target) target = c; });
    if (!target) return;
    const box = new THREE.Box3().setFromObject(target);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.max(size * 2.8, 0.35);
    camera.position.set(center.x, center.y + dist * 0.25, center.z + dist);
    camera.lookAt(center);
    if (controls) { (controls as any).target.copy(center); (controls as any).update(); }
  }, [focusMesh?.seq, scene, camera, controls]);

  useEffect(() => {
    if (!resetSeq) return;
    camera.position.set(0, 0.85, 2.6);
    camera.lookAt(0, 0.85, 0);
    if (controls) { (controls as any).target.set(0, 0.85, 0); (controls as any).update(); }
  }, [resetSeq, camera, controls]);

  return null;
}

// ─── Arrow-key orbit ───────────────────────────────────────────────────────
function ArrowKeyOrbitHandler() {
  const { camera, controls } = useThree();
  const keys = useRef({ left: false, right: false, up: false, down: false });
  const sph = useRef(new THREE.Spherical());

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft")  { keys.current.left  = true; e.preventDefault(); }
      if (e.key === "ArrowRight") { keys.current.right = true; e.preventDefault(); }
      if (e.key === "ArrowUp")    { keys.current.up    = true; e.preventDefault(); }
      if (e.key === "ArrowDown")  { keys.current.down  = true; e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")  keys.current.left  = false;
      if (e.key === "ArrowRight") keys.current.right = false;
      if (e.key === "ArrowUp")    keys.current.up    = false;
      if (e.key === "ArrowDown")  keys.current.down  = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useFrame(() => {
    const k = keys.current;
    if (!k.left && !k.right && !k.up && !k.down) return;
    if (!controls) return;
    const SPEED = 0.022;
    const offset = camera.position.clone().sub((controls as any).target);
    sph.current.setFromVector3(offset);
    if (k.left)  sph.current.theta += SPEED;
    if (k.right) sph.current.theta -= SPEED;
    if (k.up)    sph.current.phi = Math.max(0.05, sph.current.phi - SPEED);
    if (k.down)  sph.current.phi = Math.min(Math.PI - 0.05, sph.current.phi + SPEED);
    offset.setFromSpherical(sph.current);
    camera.position.copy((controls as any).target).add(offset);
    camera.lookAt((controls as any).target);
    (controls as any).update();
  });

  return null;
}

// ─── Trackpad / mouse-wheel handler ───────────────────────────────────────
function TrackpadHandler() {
  const { camera, controls, gl } = useThree();
  const vel = useRef({ ox: 0, oy: 0, px: 0, py: 0, z: 0 });
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    const v = vel.current;
    const FRICTION = 0.82, MIN = 0.00005;
    const sph = new THREE.Spherical();

    const applyOrbit = (dTheta: number, dPhi: number) => {
      if (!controls) return;
      const offset = camera.position.clone().sub((controls as any).target);
      sph.setFromVector3(offset);
      sph.theta -= dTheta;
      sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi - dPhi));
      offset.setFromSpherical(sph);
      camera.position.copy((controls as any).target).add(offset);
      camera.lookAt((controls as any).target);
      (controls as any).update();
    };
    const applyPan = (dx: number, dy: number) => {
      if (!controls) return;
      const dist = camera.position.distanceTo((controls as any).target);
      const scale = dist * 0.0018;
      const right = new THREE.Vector3();
      camera.matrix.extractBasis(right, new THREE.Vector3(), new THREE.Vector3());
      const move = new THREE.Vector3();
      move.addScaledVector(right, -dx * scale);
      move.addScaledVector(new THREE.Vector3(0, 1, 0), dy * scale);
      camera.position.add(move);
      (controls as any).target.add(move);
      (controls as any).update();
    };
    const applyZoom = (dz: number) => {
      if (!controls) return;
      const dist = camera.position.distanceTo((controls as any).target);
      const newDist = Math.max(0.002, Math.min(40, dist * (1 + dz)));
      const dir = camera.position.clone().sub((controls as any).target).normalize();
      camera.position.copy((controls as any).target).addScaledVector(dir, newDist);
      (controls as any).update();
    };

    const tick = () => {
      let alive = false;
      if (Math.abs(v.ox) > MIN || Math.abs(v.oy) > MIN) { applyOrbit(v.ox, v.oy); v.ox *= FRICTION; v.oy *= FRICTION; alive = true; }
      if (Math.abs(v.px) > MIN || Math.abs(v.py) > MIN) { applyPan(v.px, v.py);   v.px *= FRICTION; v.py *= FRICTION; alive = true; }
      if (Math.abs(v.z)  > MIN)                          { applyZoom(v.z);          v.z  *= FRICTION;                   alive = true; }
      raf.current = alive ? requestAnimationFrame(tick) : null;
    };
    const kick = () => { if (!raf.current) raf.current = requestAnimationFrame(tick); };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const isTrackpad = Math.abs(e.deltaY) < 60 || Math.abs(e.deltaX) > 1;
      if (e.ctrlKey) {
        const dist = camera.position.distanceTo((controls as any)?.target ?? new THREE.Vector3());
        v.ox = v.oy = v.px = v.py = 0;
        v.z = e.deltaY * (isTrackpad ? 0.003 : 0.006) * Math.max(0.15, Math.min(1, dist / 2));
      } else if (e.shiftKey) {
        v.ox = v.oy = v.z = 0; v.px = e.deltaX; v.py = e.deltaY;
      } else if (!isTrackpad) {
        v.ox = v.oy = v.px = v.py = 0; v.z = e.deltaY * 0.004;
      } else {
        v.px = v.py = v.z = 0; v.ox = e.deltaX * 0.004; v.oy = e.deltaY * 0.004;
      }
      kick();
    };

    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true } as any);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [camera, controls, gl]);

  return null;
}

// ─── Scene ─────────────────────────────────────────────────────────────────
function Scene({
  visibleLayers, selectedName, onSelect, highlightState,
  hiddenMeshes, onMeshesLoaded, cameraPreset, focusMesh, resetSeq, crossSection,
  selectableLayers, boneOnlyMode,
}: {
  visibleLayers: Set<string>;
  selectedName: string | null;
  onSelect: (name: string, pos: THREE.Vector3) => void;
  highlightState: HighlightState | null;
  hiddenMeshes: Set<string>;
  onMeshesLoaded: (layerId: string, meshes: MeshInfo[]) => void;
  cameraPreset: string | null;
  focusMesh: { name: string; seq: number } | null;
  resetSeq: number;
  crossSection: CrossSection | null;
  selectableLayers?: Set<string>;
  boneOnlyMode?: boolean;
}) {
  const scaleRef = useRef<SharedTransform | null>(null);
  const [scaleReady, setScaleReady] = useState(false);
  const handleBaseScale = useCallback((t: SharedTransform) => {
    scaleRef.current = t;
    setScaleReady(true);
  }, []);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 8, 5]} intensity={0.9} />
      <directionalLight position={[-4, 4, -3]} intensity={0.4} color="#c0d8ff" />
      <hemisphereLight args={["#ffffff", "#aac0d0", 0.5]} />

      <OrbitControls makeDefault enableDamping dampingFactor={0.08}
        enablePan enableZoom rotateSpeed={0.7} panSpeed={0.7} zoomSpeed={0.8}
        screenSpacePanning minDistance={0.002} maxDistance={40}
        target={[0, 0.85, 0]}
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      />

      <Suspense fallback={null}>
        {LAYERS
          .filter(l => visibleLayers.has(l.id) ? (l.id === "skeletal" || scaleReady) : (l.id === "skeletal" && !scaleReady))
          .map(layer => (
            <LayerModel
              key={layer.id}
              layer={layer}
              visible={visibleLayers.has(layer.id)}
              isBase={layer.id === "skeletal"}
              sharedScale={layer.id === "skeletal" ? null : scaleRef.current}
              onBaseScale={layer.id === "skeletal" ? handleBaseScale : undefined}
              selectedName={selectedName}
              onSelect={onSelect}
              highlightState={highlightState}
              hiddenMeshes={hiddenMeshes}
              onMeshesLoaded={onMeshesLoaded}
              clickable={selectableLayers ? selectableLayers.has(layer.id) : true}
              boneOnlyMode={boneOnlyMode}
            />
          ))}
        <EffectComposer>
          <Bloom intensity={0.3} luminanceThreshold={0.7} luminanceSmoothing={0.9} />
        </EffectComposer>
      </Suspense>

      <ClipPlaneController crossSection={crossSection} />
      {crossSection?.enabled && <ClipPlaneVisual crossSection={crossSection} />}

      <ViewportController preset={cameraPreset} focusMesh={focusMesh} resetSeq={resetSeq} />
      <ArrowKeyOrbitHandler />
      <TrackpadHandler />
    </>
  );
}

// ─── Loading overlay ───────────────────────────────────────────────────────
function LoadingOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", background: "rgba(226,232,240,0.9)", zIndex: 10 }}>
      <div className="loader" style={{ width: 32, height: 32, marginBottom: 14 }} />
      <p style={{ fontSize: 14, color: "#4a5568" }}>Loading 3D models…</p>
      <p style={{ fontSize: 12, color: "#a0aec0", marginTop: 4 }}>167 MB of anatomical data</p>
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────
export default function Viewer3D({
  visibleLayers, selectedName, onSelect, highlightState = null,
  hiddenMeshes = new Set(), onMeshesLoaded = () => {},
  cameraPreset = null, focusMesh = null, resetSeq = 0,
  crossSection = null, selectableLayers, boneOnlyMode = false,
}: {
  visibleLayers: Set<string>;
  selectedName: string | null;
  onSelect: (name: string, pos: THREE.Vector3) => void;
  highlightState?: HighlightState | null;
  hiddenMeshes?: Set<string>;
  onMeshesLoaded?: (layerId: string, meshes: MeshInfo[]) => void;
  cameraPreset?: string | null;
  focusMesh?: { name: string; seq: number } | null;
  resetSeq?: number;
  crossSection?: CrossSection | null;
  selectableLayers?: Set<string>;
  boneOnlyMode?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [darkMode] = useDarkMode();
  const sceneBg = darkMode ? "#0b1020" : "#f0f4f8";
  return (
    <div className="anatomy-viewer3d" style={{ position: "relative", width: "100%", height: "100%" }}>
      <LoadingOverlay visible={loading} />
      <Canvas
        camera={{ position: [0, 0.85, 2.6], fov: 46 }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, localClippingEnabled: true }}
        onCreated={() => setLoading(false)}
        style={{ background: sceneBg, touchAction: "none" }}
        onContextMenu={event => event.preventDefault()}
      >
        <color attach="background" args={[sceneBg]} />
        <Scene
          visibleLayers={visibleLayers} selectedName={selectedName}
          onSelect={onSelect} highlightState={highlightState}
          hiddenMeshes={hiddenMeshes} onMeshesLoaded={onMeshesLoaded}
          cameraPreset={cameraPreset} focusMesh={focusMesh} resetSeq={resetSeq}
          crossSection={crossSection} selectableLayers={selectableLayers}
          boneOnlyMode={boneOnlyMode}
        />
      </Canvas>
      <div className="anatomy-touch-hint" style={{ position: "absolute", bottom: 12, left: 12, fontSize: 11, color: "var(--text-muted)", pointerEvents: "none" }}>
        Drag rotate · Pinch zoom · Two-finger pan
      </div>
    </div>
  );
}
