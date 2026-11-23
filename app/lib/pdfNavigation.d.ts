export type PdfNavigationSource = "outline" | "index" | "search" | "recent" | "toolbar" | "route";

export interface PdfNavigationRequest {
  page: number;
  requestId: number;
  source: PdfNavigationSource;
  optionalDestination?: unknown;
}

export interface LibraryPdfDestination {
  path: string;
  page: number;
}

export interface PdfJumpState {
  requestId: number;
  page: number | null;
  settling: boolean;
}

export interface PdfTargetScrollInput {
  scrollTop: number;
  containerTop: number;
  targetTop: number;
  paddingTop?: number;
  stickyOffset?: number;
}

export const PDF_NAVIGATION_ACTIVATION_EVENT: "medos:pdf-navigation-activate";

export function parsePdfPage(value: unknown, maxPage?: number): number | null;
export function createPdfNavigationRequest(
  page: unknown,
  source: PdfNavigationSource,
  optionalDestination?: unknown,
  maxPage?: number,
): PdfNavigationRequest | null;
export function isUnseenPdfNavigationRequest(lastRequestId: number, request: PdfNavigationRequest | null | undefined): boolean;
export function parseLibraryPdfHref(href: unknown, baseHref?: string): LibraryPdfDestination | null;
export function calculatePdfTargetScroll(input: PdfTargetScrollInput): number;
export function createPdfJumpState(): PdfJumpState;
export function beginPdfJump(state: PdfJumpState, request: PdfNavigationRequest): PdfJumpState;
export function settlePdfJump(state: PdfJumpState, requestId: number): PdfJumpState;
export function reconcileObservedPdfPage(state: PdfJumpState, observedPage: number): number;
export function dispatchLibraryPdfActivation(
  href: string,
  source?: PdfNavigationSource,
  target?: Window,
): boolean;
export function requestFromLibraryPdfActivation(
  detail: unknown,
  activeBookPath: string,
  maxPage?: number,
): PdfNavigationRequest | null;
