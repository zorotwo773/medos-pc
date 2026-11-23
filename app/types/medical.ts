export interface Disease {
  disease_name: string;
  document_id?: number;
  source?: string;
  primary_organ: string;
  primary_system?: string;
  anatomy_model?: string;
  secondary_organs_involved: string[];
  clinical_synthesis?: string[];
  harrisons_synthesis?: string[];
  treatment_pearls: string[];
  icd_codes?: Array<{
    code: string;
    description: string;
    system: string;
  }>;
  aliases?: string[];
  algorithm_refs?: Array<{
    document_id: number | null;
    title: string;
    match_score: number;
    images: Array<{
      filename: string;
      url: string;
      match_score?: number;
    }>;
  }>;
  content_preview?: string;
  citation: {
    chapter_title: string;
    page_number: number;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  timestamp: Date;
}

export interface Source {
  source: string;
  page: number;
  content: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  uploadDate: string;
  pageCount: number;
}

export interface Chapter {
  id: string;
  bookId: string;
  systemId: string;
  title: string;
  startPage: number;
  endPage: number;
  content: string;
}

export interface Calculator {
  id: string;
  name: string;
  description: string;
  category: string;
  fields: CalculatorField[];
}

export interface CalculatorField {
  id: string;
  label: string;
  type: "number" | "select" | "checkbox";
  unit?: string;
  options?: { label: string; value: number }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  topic: string;
  difficulty: "easy" | "medium" | "hard";
}
