export type QbankMode = "tutor" | "exam" | string;

export interface QbankTimingSession {
  id: string;
  db: string;
  mode: QbankMode;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  current: number;
  questions: QbankReviewQuestion[];
  answers: Record<number, number>;
  answerMeta?: Record<number, QbankAnswerTimingMeta>;
  questionStartedAt?: Record<number, string>;
  questionTimeSec?: Record<number, number>;
}

export interface QbankAnswerTimingMeta {
  qid: number;
  questionIndex: number;
  choiceIndex: number;
  correctIndex: number;
  answeredAt: string;
  elapsedSec: number;
  spentSec?: number;
  remainingSec?: number;
  mode: QbankMode;
}

export interface QbankReviewQuestion {
  id: number;
  subject?: string;
  system?: string;
  system_group?: string;
  system_detail?: string;
  correct: number;
}

export interface QbankGroupStats {
  key: string;
  label: string;
  db?: string;
  total: number;
  answered: number;
  correct: number;
  wrong: number;
  omitted: number;
  accuracy: number;
  avgSec: number;
  // Total questions available in the bank(s) for this group, when facet counts are
  // supplied. `pending` is how many of those the user has not finished yet.
  available: number;
  pending: number;
}

export interface QbankTestStats extends QbankGroupStats {
  id: string;
  completedAt?: string;
  mode: QbankMode;
}

export interface QbankReviewStats {
  overall: QbankGroupStats;
  banks: QbankGroupStats[];
  subjects: QbankGroupStats[];
  systems: QbankGroupStats[];
  topics: QbankGroupStats[];
  tests: QbankTestStats[];
}

// Per-bank totals of how many questions exist for each subject / organ system /
// topic, sourced from /qbank/subjects, /qbank/system-groups and /qbank/topics.
// Keys are the human labels (case-insensitive); values are total question counts.
export interface BankFacetCounts {
  total?: number;
  subjects?: Record<string, number>;
  systems?: Record<string, number>;
  topics?: Record<string, number>;
}

export type QbankFacets = Record<string, BankFacetCounts>;

function parseTime(value: string | undefined) {
  const stamp = Date.parse(value || "");
  return Number.isFinite(stamp) ? stamp : NaN;
}

function roundPositiveSeconds(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function secondsBetween(start: string | undefined, end: string | undefined) {
  const startMs = parseTime(start);
  const endMs = parseTime(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return roundPositiveSeconds((endMs - startMs) / 1000);
}

function cloneNumberMap(value: Record<number, number> | undefined) {
  return { ...(value || {}) };
}

function cloneStringMap(value: Record<number, string> | undefined) {
  return { ...(value || {}) };
}

export function normalizeQuestionTiming<T extends QbankTimingSession>(session: T, at: string = session.updatedAt || session.createdAt): T {
  if (session.completedAt) {
    return {
      ...session,
      questionStartedAt: session.questionStartedAt || {},
      questionTimeSec: session.questionTimeSec || {},
    };
  }
  const current = Number.isInteger(session.current) ? session.current : 0;
  const questionStartedAt = cloneStringMap(session.questionStartedAt);
  if (!questionStartedAt[current]) questionStartedAt[current] = at || session.createdAt;
  return {
    ...session,
    current,
    questionStartedAt,
    questionTimeSec: session.questionTimeSec || {},
  };
}

export function stopCurrentQuestionTimer<T extends QbankTimingSession>(session: T, at: string): T {
  const current = Number.isInteger(session.current) ? session.current : 0;
  const startedAt = session.questionStartedAt?.[current];
  const spent = secondsBetween(startedAt, at);
  const questionTimeSec = cloneNumberMap(session.questionTimeSec);
  if (spent > 0) questionTimeSec[current] = roundPositiveSeconds((questionTimeSec[current] || 0) + spent);
  const questionStartedAt = cloneStringMap(session.questionStartedAt);
  delete questionStartedAt[current];
  return { ...session, questionStartedAt, questionTimeSec };
}

export function advanceCurrentQuestionTimer<T extends QbankTimingSession>(session: T, at: string): T {
  const stopped = stopCurrentQuestionTimer(session, at);
  return {
    ...stopped,
    questionStartedAt: { ...(stopped.questionStartedAt || {}), [stopped.current]: at },
  };
}

export function moveTimedQuestion<T extends QbankTimingSession>(session: T, nextCurrent: number, at: string): T {
  const boundedCurrent = Math.max(0, Math.min(session.questions.length - 1, nextCurrent));
  const stopped = stopCurrentQuestionTimer(session, at);
  if (boundedCurrent === session.current) return stopped;
  return {
    ...stopped,
    current: boundedCurrent,
    questionStartedAt: { ...(stopped.questionStartedAt || {}), [boundedCurrent]: at },
  };
}

export function finalizeQuestionTimers<T extends QbankTimingSession>(session: T, at: string): T {
  return stopCurrentQuestionTimer(session, at);
}

export function questionSpentSeconds(session: Pick<QbankTimingSession, "questionTimeSec" | "questionStartedAt" | "answerMeta"> & { current?: number }, index: number, at?: string) {
  const existing = session.questionTimeSec?.[index] || 0;
  const active = at ? secondsBetween(session.questionStartedAt?.[index], at) : 0;
  const metaSpent = session.answerMeta?.[index]?.spentSec;
  return roundPositiveSeconds(Math.max(existing + active, typeof metaSpent === "number" ? metaSpent : 0));
}

export function recordTimedAnswer<T extends QbankTimingSession>(
  session: T,
  options: { choiceIndex: number; at: string; remainingSec?: number; stopTimer?: boolean },
): T {
  const question = session.questions[session.current];
  if (!question) return session;
  const timed = options.stopTimer ? stopCurrentQuestionTimer(session, options.at) : advanceCurrentQuestionTimer(session, options.at);
  const spentSec = questionSpentSeconds(timed, session.current);
  const answerMeta: QbankAnswerTimingMeta = {
    qid: question.id,
    questionIndex: session.current,
    choiceIndex: options.choiceIndex,
    correctIndex: question.correct - 1,
    answeredAt: options.at,
    elapsedSec: spentSec,
    spentSec,
    remainingSec: options.remainingSec,
    mode: session.mode,
  };
  return {
    ...timed,
    answers: { ...timed.answers, [session.current]: options.choiceIndex },
    answerMeta: { ...(timed.answerMeta || {}), [session.current]: answerMeta },
  };
}

export function formatQuestionTime(seconds: number | undefined) {
  const safe = roundPositiveSeconds(seconds || 0);
  if (safe < 60) return `${safe} sec`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
}

function emptyGroup(key: string, label: string, db?: string): QbankGroupStats {
  return { key, label, db, total: 0, answered: 0, correct: 0, wrong: 0, omitted: 0, accuracy: 0, avgSec: 0, available: 0, pending: 0 };
}

function normalizeFacetKey(label: string) {
  return (label || "").trim().toLowerCase();
}

// Sum the available-question count for one group label across every bank in scope.
function facetAvailableFor(
  facets: QbankFacets,
  kind: "subjects" | "systems" | "topics",
  groupKey: string,
  selectedDb: string,
) {
  let total = 0;
  for (const dbKey of Object.keys(facets)) {
    if (selectedDb !== "all" && dbKey !== selectedDb) continue;
    const map = facets[dbKey]?.[kind];
    if (!map) continue;
    for (const label of Object.keys(map)) {
      if (normalizeFacetKey(label) === groupKey) total += map[label] || 0;
    }
  }
  return total;
}

function bankTotalAvailable(facets: QbankFacets, selectedDb: string) {
  let total = 0;
  for (const dbKey of Object.keys(facets)) {
    if (selectedDb !== "all" && dbKey !== selectedDb) continue;
    total += facets[dbKey]?.total || 0;
  }
  return total;
}

function addQuestionToGroup(group: QbankGroupStats, session: QbankTimingSession, index: number) {
  const question = session.questions[index];
  const answer = session.answers?.[index];
  const answered = answer !== undefined && answer !== null;
  const correct = answered && question ? answer === question.correct - 1 : false;
  group.total += 1;
  if (answered) group.answered += 1;
  if (correct) group.correct += 1;
  else if (answered) group.wrong += 1;
  else group.omitted += 1;
  group.avgSec += questionSpentSeconds(session, index);
}

function finalizeGroup(group: QbankGroupStats) {
  return {
    ...group,
    accuracy: group.answered ? Math.round((group.correct / group.answered) * 100) : 0,
    avgSec: group.total ? Math.round(group.avgSec / group.total) : 0,
    pending: group.available ? Math.max(0, group.available - group.total) : 0,
  };
}

function sortedGroups(groups: Map<string, QbankGroupStats>) {
  return Array.from(groups.values()).map(finalizeGroup).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.label.localeCompare(b.label);
  });
}

export function buildQbankReviewStats(
  sessions: QbankTimingSession[],
  selectedDb: string = "all",
  facets: QbankFacets = {},
): QbankReviewStats {
  const included = sessions
    .filter(session => session.completedAt && (selectedDb === "all" || session.db === selectedDb))
    .sort((a, b) => parseTime(b.completedAt) - parseTime(a.completedAt));
  const overall = emptyGroup("overall", selectedDb === "all" ? "All selected Q-banks" : selectedDb);
  const banks = new Map<string, QbankGroupStats>();
  const subjects = new Map<string, QbankGroupStats>();
  const systems = new Map<string, QbankGroupStats>();
  const topics = new Map<string, QbankGroupStats>();
  const tests: QbankTestStats[] = [];

  for (const session of included) {
    const test = emptyGroup(session.id, session.id, session.db) as QbankTestStats;
    test.id = session.id;
    test.completedAt = session.completedAt;
    test.mode = session.mode;

    for (let index = 0; index < session.questions.length; index += 1) {
      const question = session.questions[index];
      addQuestionToGroup(overall, session, index);
      addQuestionToGroup(test, session, index);

      const bankGroup = banks.get(session.db) || emptyGroup(session.db, session.db, session.db);
      addQuestionToGroup(bankGroup, session, index);
      banks.set(session.db, bankGroup);

      const subjectLabel = (question.subject || "Unassigned subject").trim() || "Unassigned subject";
      const subjectKey = subjectLabel.toLowerCase();
      const subjectGroup = subjects.get(subjectKey) || emptyGroup(subjectKey, subjectLabel, selectedDb === "all" ? undefined : session.db);
      addQuestionToGroup(subjectGroup, session, index);
      subjects.set(subjectKey, subjectGroup);

      const systemLabel = (question.system_group || question.system || "Unassigned system").trim() || "Unassigned system";
      const systemKey = systemLabel.toLowerCase();
      const systemGroup = systems.get(systemKey) || emptyGroup(systemKey, systemLabel, selectedDb === "all" ? undefined : session.db);
      addQuestionToGroup(systemGroup, session, index);
      systems.set(systemKey, systemGroup);

      const topicLabel = (question.system_detail || "Unassigned topic").trim() || "Unassigned topic";
      const topicKey = topicLabel.toLowerCase();
      const topicGroup = topics.get(topicKey) || emptyGroup(topicKey, topicLabel, selectedDb === "all" ? undefined : session.db);
      addQuestionToGroup(topicGroup, session, index);
      topics.set(topicKey, topicGroup);
    }

    test.available = facets[session.db]?.total || 0;
    tests.push(finalizeGroup(test) as QbankTestStats);
  }

  overall.available = bankTotalAvailable(facets, selectedDb);
  for (const [db, group] of banks) group.available = facets[db]?.total || 0;
  for (const [key, group] of subjects) group.available = facetAvailableFor(facets, "subjects", key, selectedDb);
  for (const [key, group] of systems) group.available = facetAvailableFor(facets, "systems", key, selectedDb);
  for (const [key, group] of topics) group.available = facetAvailableFor(facets, "topics", key, selectedDb);

  return {
    overall: finalizeGroup(overall),
    banks: sortedGroups(banks),
    subjects: sortedGroups(subjects),
    systems: sortedGroups(systems),
    topics: sortedGroups(topics),
    tests,
  };
}
