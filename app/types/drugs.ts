export interface DrugQuickInfo {
  drug_id: number;
  generic_name: string;
  brand_names: string;
  drug_class: string;
  dose_snippet: string;
  bbw_snippet: string | null;
  regulatory_status: string;
  has_black_box: boolean;
  href: string;
  alias_match?: string;
}

export interface DrugClassSummary {
  class_name: string;
  count: number;
}

export interface DrugClassSubnode {
  id: number;
  name: string;
  source: string;
  drug_count: number;
}

export interface DrugClassArea {
  id: number;
  name: string;
  drug_count: number;
  subclasses: DrugClassSubnode[];
}

export interface DrugClassTree {
  available: boolean;
  areas: DrugClassArea[];
}

export interface DrugSection {
  html: string;
  text: string;
  source: "mm" | "utd";
}

export interface OpenFdaSection {
  key: string;
  label: string;
  text: string;
}

export interface OpenFdaLabel {
  set_id: string;
  doc_id: string;
  brand_names: string[];
  generic_names: string[];
  manufacturer: string;
  rxcuis: string[];
  ndcs: string[];
  has_black_box: boolean;
  sections: OpenFdaSection[];
  fda_url: string;
}

export interface DrugProfile {
  drug_id: number;
  generic_name: string;
  brand_names: string[];
  drug_class: string[];
  has_black_box: boolean;
  regulatory_status: string;
  is_generic_available: boolean;
  utd_topic_id: number | null;
  identity?: DrugIdentity;
  quick_info: { dose_snippet: string; bbw_snippet: string | null };
  openfda?: OpenFdaLabel | null;
  sections: {
    adult_dosing?: DrugSection;
    adult_dosing_elderly?: DrugSection;
    pediatric_dosing?: DrugSection;
    renal_dosing?: DrugSection;
    hepatic_dosing?: DrugSection;
    renal_dosing_pediatric?: DrugSection;
    black_box_warning?: DrugSection;
    adverse_effects?: DrugSection;
    adverse_effects_significant?: DrugSection;
    interactions_contraindicated?: DrugSection;
    interactions_major?: DrugSection;
    interactions_moderate?: DrugSection;
    contraindications?: DrugSection;
    precautions?: DrugSection;
    mechanism?: DrugSection;
    pharmacokinetics?: DrugSection;
    absorption?: DrugSection;
    distribution?: DrugSection;
    metabolism?: DrugSection;
    excretion?: DrugSection;
    half_life?: DrugSection;
    administration?: DrugSection;
    monitoring?: DrugSection;
    how_supplied?: DrugSection;
    indications?: DrugSection;
    pregnancy?: DrugSection;
    breast_feeding?: DrugSection;
    toxicology_effects?: DrugSection;
    toxicology_treatment?: DrugSection;
  };
  icd_codes: Array<{ icd9: string; icd10: string; description: string }>;
  related_links: Array<{ source: string; href: string; title: string }>;
  clinical_umls?: ClinicalUmls;
}

export interface UmlsConceptRef {
  cui: string;
  name: string;
  source: string;
}

export interface ClinicalUmls {
  cui: string | null;
  mechanism_class: UmlsConceptRef[];
  physiologic_effects: UmlsConceptRef[];
  indications: UmlsConceptRef[];
  may_prevent: UmlsConceptRef[];
  contraindications: UmlsConceptRef[];
  reactions: UmlsConceptRef[];
}

export interface DrugIdentity {
  rxcui: string | null;
  rxcui_tty: string | null;
  coverage_tier: number;
  coverage_status: string | null;
  ingredients: Ingredient[];
  atc: Array<{ atc_code: string; atc_name: string; level: number }>;
  ndcs: Array<{ ndc: string; package_desc: string | null }>;
  dose_forms: Array<{ dose_form: string; route: string | null }>;
  strengths: Array<{
    strength_num: number | null;
    strength_unit: string | null;
    strength_text: string;
    dose_form: string | null;
    route: string | null;
  }>;
  form_options?: DoseFormOption[];
}

export interface DoseFormOption {
  dose_form: string | null;
  route: string | null;
  strength_unit: string | null;
  strength_count: number;
  strengths: string[];
}

export interface DoseCalculation {
  drug_id: number;
  generic_name: string;
  weight_kg: number;
  crcl: number | null;
  indication: string | null;
  source_section: string;
  source: string;
  calculated: {
    base_dose_text: string;
    weight_adjusted: string | null;
    renal_note: string | null;
    frequency: string | null;
    route: string | null;
    confidence: "high" | "medium" | "low";
  };
  disclaimer: string;
}

export interface Indication {
  id: number;
  indication_text: string;
  indication_rank: number;
  label_status?: "fda_labeled" | "off_label" | "unsupported" | "source_listed" | "dosing_section" | null;
  source_name?: string | null;
  confidence: "reviewed" | "high" | "medium" | "low";
  review_status: "unreviewed" | "needs_review" | "reviewed" | "rejected";
}

export interface WarningQuick {
  warning_text: string;
  severity: "boxed" | "major" | "common";
  source_name: string | null;
  confidence: "reviewed" | "high" | "medium" | "low";
  review_status: string;
}

export interface InteractionQuick {
  interacting_rxcui: string | null;
  interacting_name: string;
  severity: "contraindicated" | "major" | "moderate";
  mechanism: string | null;
  source_name: string | null;
  confidence: "reviewed" | "high" | "medium" | "low";
  review_status: string;
}

export interface SideEffectQuick {
  effect_text: string;
  frequency: "common" | "serious";
  source_name: string | null;
  confidence: "reviewed" | "high" | "medium" | "low";
  review_status: string;
}

export interface Ingredient {
  ingredient_rxcui: string | null;
  ingredient_name: string;
  strength: string | null;
  unit: string | null;
}

export interface DrugPopup {
  drug: {
    drug_id: number;
    generic_name: string;
    brand_names: string[];
    drug_class: string[];
    regulatory_status: string;
    has_black_box: boolean;
    is_generic_available: boolean;
    utd_topic_id: number | null;
    rxcui: string | null;
    rxcui_tty: string | null;
    coverage_tier: number;
    coverage_status: string;
    dose_snippet: string;
    bbw_snippet: string | null;
  };
  indications: Indication[];
  warnings_quick: WarningQuick[];
  side_effects_quick: SideEffectQuick[];
  interactions_quick: InteractionQuick[];
  ingredients: Ingredient[];
  default_indication_id: number | null;
  default_indication_reason?: string | null;
  default_weight_kg?: number;
  dosing: {
    available: boolean;
    rx_ready: boolean;
    rule_count: number;
    rx_ready_rule_count: number;
  };
  adjustments?: {
    renal_available: boolean;
    hepatic_available: boolean;
  };
  identity: DrugIdentity;
  disclaimer: string;
}

export interface Prescription {
  drug_display: string;
  sig: string;
  dispense: string;
  refills: number;
  duration_days: number;
  days_supply?: number;
  schedule_context?: string | null;
}

export interface AdjustmentGuidance {
  input: number | string;
  status: "avoid" | "no_change" | "factor" | "day_cap" | "replace" | "increase_possible" | "verify" | "none";
  factor: number | null;
  max_mg_per_day?: number | null;
  message: string;
  source_text: string;
}

export interface DoseResult {
  drug_id: number;
  indication: { id: number; text: string } | null;
  indication_fallback: { requested_id: number; requested_text: string | null; used_text: string | null } | null;
  renal_guidance: AdjustmentGuidance | null;
  hepatic_guidance: AdjustmentGuidance | null;
  population: "adult" | "pediatric" | null;
  route: string | null;
  dose_form: string | null;
  computed_mg_per_dose: number | null;
  computed_dose: number | null;
  dose_unit: string | null;
  weight_kg: number | null;
  default_weight_used: boolean;
  default_indication_used: boolean;
  doses_per_day: number | null;
  total_mg_per_day: number | null;
  capped_by_max: boolean;
  adjustments_applied: string[];
  prescription: Prescription | null;
  confidence: "reviewed" | "high" | "medium" | "low";
  review_status: string;
  source: { section_id: number | null; name: string | null; method: string | null } | null;
  rule_id: number | null;
  rx_ready: boolean;
  needs: string[];
  assumptions: string[];
  display: string | null;
  notes: string | null;
  parse_warnings: string[];
  calculation_steps?: string[];
  dose_notes?: string[];
  max_mg_per_day_ceiling?: number | null;
  disclaimer: string;
}

export interface DrugHealth {
  configured: boolean;
  exists: boolean;
  drug_count?: number;
  built_at?: string;
  mm_version?: string;
  section_count?: string;
  utd_used?: string;
  rxnorm_linked_at?: string;
  rxcui_match_rate?: string;
  rxcui_dedupe_alias_count?: string;
  rxcui_dedupe_skipped_conflicts?: string;
  clinical_extracted_at?: string;
  structured_dosing_rate?: string;
  rx_ready_dosing_rate?: string;
  mm_interaction_db_used?: string;
  mm_interaction_quick_rows?: string;
}
