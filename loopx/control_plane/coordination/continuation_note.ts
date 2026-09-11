/** Shared continuation-note validation for the explicit cross-agent handoff flow.
 * This is the single source of truth for whether a note is a valid prepared
 * continuation note. Both the handoff helper (todo_continuation.ts) and the
 * final claim authority (todo_claim.ts) use this to prevent arbitrary JSON
 * notes from being accepted as handoff intent.
 *
 * The note schema supports two shapes:
 * - Legacy: rationale + source_refs (backward compatible)
 * - Rich: work_summary + structured context (approaches_tried, next_steps, etc.)
 * A note is valid if it carries the marker, current todo_facts, a source_session,
 * and at least one of (work_summary, rationale).
 */
import type { JsonObject } from "../effect_program.ts";
import { canonicalAuthorityObject, canonicalAuthoritySha256 } from "./authority_store_codec.ts";

export const CONTINUATION_NOTE_MARKER = "loopx-explicit-continuation";

// Any changed execution fact expires the note. Audit-only writes do not.
export function computeContinuationTodoFacts(todo: JsonObject): string {
  const copy = { ...todo };
  for (const key of ["note", "updated_at", "last_actor_agent_id"]) delete copy[key];
  return canonicalAuthoritySha256(copy);
}

export interface ContinuationNoteApproachTried {
  readonly approach: string;
  readonly outcome: "success" | "partial" | "failed";
  readonly reason: string;
}

export interface ContinuationNoteFileTouched {
  readonly path: string;
  readonly action: "read" | "edited" | "created" | "deleted";
  readonly summary?: string;
}

export interface ContinuationNoteDecision {
  readonly decision: string;
  readonly rationale: string;
}

// Input shape for constructing a rich continuation note.
export interface ContinuationNoteContext {
  readonly work_summary?: string;
  readonly approaches_tried?: readonly ContinuationNoteApproachTried[];
  readonly next_steps?: readonly string[];
  readonly files_touched?: readonly ContinuationNoteFileTouched[];
  readonly key_decisions?: readonly ContinuationNoteDecision[];
  readonly open_questions?: readonly string[];
  // Legacy fields (still supported for backward compat):
  readonly rationale?: string;
  readonly source_refs?: readonly string[];
}

export interface ContinuationNoteValidation {
  readonly valid: boolean;
  readonly note: JsonObject | null;
  readonly noteFacts: string;
}

// Exact closed bounded schema for continuation notes. This is the single
// source of truth shared by both the producer (buildContextFromInput) and the
// final claim authority (validateContinuationNote). Every constraint here
// MUST match what the producer can generate — otherwise the final authority
// accepts notes that no producer can create.
//
export const CONTINUATION_NOTE_CONTEXT_FIELDS = [
  "work_summary",
  "rationale",
  "source_refs",
  "approaches_tried",
  "next_steps",
  "files_touched",
  "key_decisions",
  "open_questions",
] as const;

const CONTEXT_KEYS = new Set<string>(CONTINUATION_NOTE_CONTEXT_FIELDS);
const NOTE_ROOT_KEYS = new Set<string>([
  "kind",
  "source_session",
  "todo_facts",
  ...CONTINUATION_NOTE_CONTEXT_FIELDS,
]);

// Per-field max lengths. Must match buildContextFromInput bounds exactly.
const FIELD_MAX = {
  source_session: 160,
  work_summary: 2000,
  rationale: 600,
  source_ref: 180,
  approach: 300,
  reason: 300,
  next_step: 300,
  path: 240,
  file_summary: 200,
  decision: 300,
  decision_rationale: 300,
  open_question: 300,
} as const;

// Nested object allowed keys.
const APPROACH_KEYS = new Set(["approach", "outcome", "reason"]);
const FILE_KEYS = new Set(["path", "action", "summary"]);
const DECISION_KEYS = new Set(["decision", "rationale"]);

function boundedString(value: unknown, name: string, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every(k => allowed.has(k));
}

function firstUnknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(obj).find(key => !allowed.has(key));
}

function isApproachTried(value: unknown): value is ContinuationNoteApproachTried {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!hasOnlyKeys(v, APPROACH_KEYS)) return false;
  return boundedString(v.approach, "approach", FIELD_MAX.approach) &&
    typeof v.outcome === "string" && ["success", "partial", "failed"].includes(v.outcome) &&
    boundedString(v.reason, "reason", FIELD_MAX.reason);
}

function isFileTouched(value: unknown): value is ContinuationNoteFileTouched {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!hasOnlyKeys(v, FILE_KEYS)) return false;
  return boundedString(v.path, "path", FIELD_MAX.path) &&
    typeof v.action === "string" && ["read", "edited", "created", "deleted"].includes(v.action) &&
    (v.summary === undefined || boundedString(v.summary, "summary", FIELD_MAX.file_summary));
}

function isDecision(value: unknown): value is ContinuationNoteDecision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!hasOnlyKeys(v, DECISION_KEYS)) return false;
  return boundedString(v.decision, "decision", FIELD_MAX.decision) &&
    boundedString(v.rationale, "decision_rationale", FIELD_MAX.decision_rationale);
}

function continuationContextError(context: JsonObject): string | null {
  const unknown = firstUnknownKey(context, CONTEXT_KEYS);
  if (unknown !== undefined) return `unknown continuation context field: ${unknown}`;
  if (context.work_summary !== undefined &&
      !boundedString(context.work_summary, "work_summary", FIELD_MAX.work_summary)) {
    return `work_summary must be non-empty text of at most ${FIELD_MAX.work_summary} characters`;
  }
  if (context.rationale !== undefined &&
      !boundedString(context.rationale, "rationale", FIELD_MAX.rationale)) {
    return `rationale must be non-empty text of at most ${FIELD_MAX.rationale} characters`;
  }
  if (context.work_summary === undefined && context.rationale === undefined) {
    return "provide at least one of: work_summary (rich context) or rationale (legacy)";
  }
  if (context.source_refs !== undefined && (!Array.isArray(context.source_refs) ||
      context.source_refs.length > 20 ||
      !context.source_refs.every(value => boundedString(value, "source_ref", FIELD_MAX.source_ref)))) {
    return "source_refs must contain at most 20 non-empty strings of at most 180 characters";
  }
  if (context.approaches_tried !== undefined) {
    if (!Array.isArray(context.approaches_tried) || context.approaches_tried.length > 20) {
      return "approaches_tried must be an array of at most 20 entries";
    }
    for (const value of context.approaches_tried) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "approaches_tried entries must be objects";
      }
      const nestedUnknown = firstUnknownKey(value as Record<string, unknown>, APPROACH_KEYS);
      if (nestedUnknown !== undefined) return `unknown approaches_tried field: ${nestedUnknown}`;
      const entry = value as Record<string, unknown>;
      if (typeof entry.outcome !== "string" || !["success", "partial", "failed"].includes(entry.outcome)) {
        return "approaches_tried outcome must be success, partial, or failed";
      }
      if (!isApproachTried(value)) return "approaches_tried entries must contain bounded approach, outcome, and reason fields";
    }
  }
  if (context.next_steps !== undefined && (!Array.isArray(context.next_steps) ||
      context.next_steps.length > 20 ||
      !context.next_steps.every(value => boundedString(value, "next_step", FIELD_MAX.next_step)))) {
    return "next_steps must contain at most 20 non-empty strings of at most 300 characters";
  }
  if (context.files_touched !== undefined) {
    if (!Array.isArray(context.files_touched) || context.files_touched.length > 50) {
      return "files_touched must be an array of at most 50 entries";
    }
    for (const value of context.files_touched) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "files_touched entries must be objects";
      }
      const nestedUnknown = firstUnknownKey(value as Record<string, unknown>, FILE_KEYS);
      if (nestedUnknown !== undefined) return `unknown files_touched field: ${nestedUnknown}`;
      const entry = value as Record<string, unknown>;
      if (typeof entry.action !== "string" || !["read", "edited", "created", "deleted"].includes(entry.action)) {
        return "files_touched action must be read, edited, created, or deleted";
      }
      if (!isFileTouched(value)) return "files_touched entries must contain bounded path, action, and optional summary fields";
    }
  }
  if (context.key_decisions !== undefined) {
    if (!Array.isArray(context.key_decisions) || context.key_decisions.length > 20) {
      return "key_decisions must be an array of at most 20 entries";
    }
    for (const value of context.key_decisions) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "key_decisions entries must be objects";
      }
      const nestedUnknown = firstUnknownKey(value as Record<string, unknown>, DECISION_KEYS);
      if (nestedUnknown !== undefined) return `unknown key_decisions field: ${nestedUnknown}`;
      if (!isDecision(value)) return "key_decisions entries must contain bounded decision and rationale fields";
    }
  }
  if (context.open_questions !== undefined && (!Array.isArray(context.open_questions) ||
      context.open_questions.length > 20 ||
      !context.open_questions.every(value => boundedString(value, "open_question", FIELD_MAX.open_question)))) {
    return "open_questions must contain at most 20 non-empty strings of at most 300 characters";
  }
  return null;
}

export function parseContinuationNoteContext(rawContext: unknown): ContinuationNoteContext {
  const context = canonicalAuthorityObject(rawContext, "continuation context");
  const error = continuationContextError(context);
  if (error !== null) throw new Error(error);
  return context as unknown as ContinuationNoteContext;
}

export function validateContinuationNote(
  rawNote: unknown,
  currentTodoFacts: string,
): ContinuationNoteValidation {
  let parsed: JsonObject | null = null;
  try {
    if (typeof rawNote === "string" && rawNote.length > 0) {
      parsed = canonicalAuthorityObject(JSON.parse(rawNote), "continuation note");
    }
  } catch {
    return { valid: false, note: null, noteFacts: "" };
  }
  if (parsed === null) {
    return { valid: false, note: null, noteFacts: "" };
  }
  // Core invariant: marker, current todo_facts, source session (non-empty, bounded).
  if (parsed.kind !== CONTINUATION_NOTE_MARKER || parsed.todo_facts !== currentTodoFacts ||
      !boundedString(parsed.source_session, "source_session", FIELD_MAX.source_session)) {
    return { valid: false, note: parsed, noteFacts: "" };
  }
  // Reject unknown root keys — the schema is closed.
  if (!hasOnlyKeys(parsed as Record<string, unknown>, NOTE_ROOT_KEYS)) {
    return { valid: false, note: parsed, noteFacts: "" };
  }
  const context: JsonObject = {};
  for (const field of CONTINUATION_NOTE_CONTEXT_FIELDS) {
    if (parsed[field] !== undefined) context[field] = parsed[field];
  }
  if (continuationContextError(context) !== null) return { valid: false, note: parsed, noteFacts: "" };
  return {
    valid: true,
    note: parsed,
    noteFacts: canonicalAuthoritySha256(parsed),
  };
}

// Build the canonical continuation note object from a context input.
// Caller is responsible for setting source_session and todo_facts.
export function buildContinuationNote(
  context: ContinuationNoteContext,
  sourceSession: string,
  todoFacts: string,
): JsonObject {
  const note: JsonObject = {
    kind: CONTINUATION_NOTE_MARKER,
    source_session: sourceSession,
    todo_facts: todoFacts,
  };
  if (context.work_summary) note.work_summary = context.work_summary;
  if (context.rationale) note.rationale = context.rationale;
  if (context.source_refs) note.source_refs = context.source_refs;
  if (context.approaches_tried) note.approaches_tried = context.approaches_tried;
  if (context.next_steps) note.next_steps = context.next_steps;
  if (context.files_touched) note.files_touched = context.files_touched;
  if (context.key_decisions) note.key_decisions = context.key_decisions;
  if (context.open_questions) note.open_questions = context.open_questions;
  return note;
}
