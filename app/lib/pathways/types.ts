/* Shared types for the MedOS Pathways module (mirrors the backend graph JSON
   emitted by scripts/build_pathways.py + served by pathways_reader.py). */

export type NodeKind = "decision" | "action" | "outcome";

export interface Branch {
  to: string;
  label: string;
}

export interface PathwayNode {
  kind: NodeKind;
  title: string;
  titleHtml: string;
  question: string;
  variable: string;
  teachingHtml: string;
  resourceKeys: string[];
  branches: Branch[];
}

export type ResourceType =
  | "topic" | "drug" | "graphic" | "pathway" | "info" | "authors" | "guideline" | "ref";

export interface PathwayResource {
  type: ResourceType;
  route: string | null;
  label: string;
  contentId: number | null;
  inlineHtml: string | null;
}

export interface PathwayGraph {
  rootId: string;
  nodes: Record<string, PathwayNode>;
  resources: Record<string, PathwayResource>;
}

export interface PathwayMeta {
  id: number;
  content_id: number | null;
  title: string;
  specialty_id: number | null;
  specialty: string | null;
  root_id: string;
  scope_html: string;
  num_steps: number;
  num_decisions: number;
  num_outcomes: number;
  est_minutes: number;
}

export interface PathwayDetail {
  meta: PathwayMeta;
  graph: PathwayGraph;
}

export interface PathwayCard {
  id: number;
  title: string;
  num_steps: number;
  num_decisions: number;
  num_outcomes: number;
  est_minutes: number;
}

export interface SpecialtyGroup {
  id: number;
  name: string;
  count: number;
  pathways: PathwayCard[];
}

export interface CaseFinding {
  node: string;
  step: number;
  question: string;
  value: string;
}

export interface CaseSeed {
  seed: number;
  path: string[];
  targetLeafId: string;
  correctBranchByNode: Record<string, string>;
  outcome: { id: string; title: string; teachingHtml: string };
  decisionCount: number;
  patientCard: {
    vignette: string;
    scope: string;
    findings: CaseFinding[];
  };
}
