export interface QbankBankMeta {
  category: "uworld" | "amboss" | "nbme" | "cms" | "mehlman" | "boardvitals" | "mksap" | "imported";
  step?: number | null;
  subject?: string | null;
  form?: string | null;
  label: string;
}

export interface QbankSelection {
  db: string;
  meta: QbankBankMeta;
}

export interface WorkspaceTab {
  id: string;
  href: string;
  title: string;
  created: number;
  tabKey?: string;
}

export const QBANK_LAST_SELECTION_KEY: "medos.qbank.last-selection.v1";
export const QBANK_ACTIVE_TAB_KEY: "qbank-active-block";
export function readQbankSelection(storage: Pick<Storage, "getItem"> | null | undefined, fallback: QbankSelection): QbankSelection;
export function writeQbankSelection(storage: Pick<Storage, "setItem"> | null | undefined, selection: QbankSelection): boolean;
export function buildQbankActiveTab(session: { id: string; db?: string; current: number; questions: unknown[]; completedAt?: string }, bankLabel?: string): Pick<WorkspaceTab, "tabKey" | "href" | "title"> | null;
export function upsertWorkspaceTab(tabs: WorkspaceTab[], incoming: WorkspaceTab): WorkspaceTab[];
export function findQbankResumeSession<T extends { id: string; completedAt?: string }>(sessions: T[], resumeId: string | null | undefined): T | null;
