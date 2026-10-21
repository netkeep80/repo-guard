import { normalizeDocumentFact } from "../document-facts.mjs";
import { durablePointer } from "./canonical-requirements.mjs";

export type SubjectRef =
  | { kind: "requirement"; id: string }
  | { kind: "resource"; path: string; pointer?: string }
  | { kind: "relation"; id: string };

export type RelationMeaning = "depends_on" | "derives_from" | "requires" | "trace";

export interface SubjectRelation {
  id?: string;
  meaning: RelationMeaning;
  role?: string;
  source: SubjectRef;
  target: SubjectRef;
}

export interface AcyclicRelationSelection {
  meaning: "depends_on";
  roles: readonly string[];
}

export interface SubjectRelationInput {
  subjects: readonly SubjectRef[];
  relations: readonly SubjectRelation[];
  roles?: readonly string[];
  acyclic?: readonly AcyclicRelationSelection[];
}

export interface SubjectRelationError {
  code:
    | "invalid_subject"
    | "duplicate_subject"
    | "duplicate_relation_id"
    | "duplicate_relation"
    | "missing_subject"
    | "unknown_meaning"
    | "unknown_role"
    | "invalid_domain"
    | "invalid_acyclic_selection"
    | "relation_cycle";
  subject: string;
  detail?: string;
}

export interface SubjectRelationResult {
  ok: boolean;
  subjects: readonly SubjectRef[];
  relations: readonly SubjectRelation[];
  errors: readonly SubjectRelationError[];
}

const idPattern = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const rolePattern = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const meanings = new Set<RelationMeaning>(["depends_on", "derives_from", "requires", "trace"]);

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stable(record[key])).join(",") + "}";
  }
  throw new Error("non-canonical subject relation value");
}

function diagnosticKey(value: unknown): string {
  try { return stable(value); }
  catch { return "<invalid>"; }
}

function safePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("resource path must be a string");
  const normalized = normalizeDocumentFact(value, "repository_path");
  if (normalized !== value || /[*?\[\]{}]/.test(value) || value.endsWith("/"))
    throw new Error("resource path must be exact and canonical");
  return value;
}

function safePointer(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (value !== "" && (!value.startsWith("/") || /~(?:[^01]|$)/.test(value))))
    throw new Error("resource pointer must be a valid JSON Pointer");
  if (!durablePointer(value)) throw new Error("resource pointer must be durable and non-positional");
  return value;
}

export function normalizeSubjectRef(raw: SubjectRef): SubjectRef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SubjectRef must be an object");
  const value = raw as SubjectRef & Record<string, unknown>;
  if (value.kind === "requirement") {
    if (Object.keys(value).sort().join(",") !== "id,kind" || typeof value.id !== "string" || !idPattern.test(value.id))
      throw new Error("invalid Requirement SubjectRef");
    return { kind: "requirement", id: value.id };
  }
  if (value.kind === "resource") {
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "kind,path" && keys !== "kind,path,pointer") throw new Error("invalid Resource SubjectRef fields");
    const path = safePath(value.path);
    const pointer = safePointer(value.pointer);
    return { kind: "resource", path, ...(pointer !== undefined ? { pointer } : {}) };
  }
  if (value.kind === "relation") {
    if (Object.keys(value).sort().join(",") !== "id,kind" || typeof value.id !== "string" || !idPattern.test(value.id))
      throw new Error("invalid Relation SubjectRef");
    return { kind: "relation", id: value.id };
  }
  throw new Error("unknown SubjectRef kind");
}

export function subjectRefKey(ref: SubjectRef): string {
  return stable(normalizeSubjectRef(ref));
}

function relationKey(relation: SubjectRelation): string {
  return stable({
    meaning: relation.meaning,
    role: relation.role || "",
    source: normalizeSubjectRef(relation.source),
    target: normalizeSubjectRef(relation.target),
  });
}

function validateDomain(relation: SubjectRelation): string | null {
  if (relation.meaning === "derives_from") {
    if (relation.source.kind !== "requirement" || relation.target.kind !== "requirement")
      return "derives_from is normative provenance and requires Requirement source and target";
  }
  if (relation.meaning === "requires") {
    if (relation.source.kind !== "requirement")
      return "requires is normative and requires Requirement source";
  }
  return null;
}

function selectedCycle(
  relations: readonly SubjectRelation[],
  selection: AcyclicRelationSelection,
): string[] | null {
  const selected = relations.filter(relation =>
    relation.meaning === selection.meaning &&
    relation.role !== undefined &&
    selection.roles.includes(relation.role));
  const adjacency = new Map<string, string[]>();
  for (const relation of selected) {
    const source = subjectRefKey(relation.source);
    const target = subjectRefKey(relation.target);
    const list = adjacency.get(source) || [];
    list.push(target);
    adjacency.set(source, list);
  }
  for (const [key, list] of adjacency) adjacency.set(key, [...new Set(list)].sort());

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      return [...stack.slice(index), node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of [...adjacency.keys()].sort()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export function evaluateSubjectRelations(input: SubjectRelationInput): SubjectRelationResult {
  const errors: SubjectRelationError[] = [];
  const subjects = new Map<string, SubjectRef>();

  for (const raw of input.subjects) {
    try {
      const subject = normalizeSubjectRef(raw);
      if (subject.kind === "relation") {
        errors.push({ code: "invalid_subject", subject: stable(subject), detail: "relation subjects are introduced by named Relation records" });
        continue;
      }
      const key = subjectRefKey(subject);
      if (subjects.has(key)) errors.push({ code: "duplicate_subject", subject: key });
      else subjects.set(key, subject);
    } catch (error) {
      errors.push({ code: "invalid_subject", subject: diagnosticKey(raw), detail: (error as Error).message });
    }
  }

  const roles = [...new Set(input.roles || [])].sort();
  for (const role of roles)
    if (typeof role !== "string" || !rolePattern.test(role))
      errors.push({ code: "unknown_role", subject: String(role), detail: "role name is malformed" });
  const roleSet = new Set(roles);

  const relationIds = new Map<string, SubjectRelation>();
  for (const raw of input.relations) {
    if (raw.id !== undefined) {
      if (!idPattern.test(raw.id)) errors.push({ code: "duplicate_relation_id", subject: String(raw.id), detail: "relation id is malformed" });
      else if (relationIds.has(raw.id)) errors.push({ code: "duplicate_relation_id", subject: raw.id });
      else relationIds.set(raw.id, raw);
    }
  }

  const normalized: SubjectRelation[] = [];
  const seen = new Set<string>();
  for (const raw of input.relations) {
    let source: SubjectRef;
    let target: SubjectRef;
    try {
      source = normalizeSubjectRef(raw.source);
      target = normalizeSubjectRef(raw.target);
    } catch (error) {
      errors.push({ code: "invalid_subject", subject: raw.id || diagnosticKey(raw), detail: (error as Error).message });
      continue;
    }
    if (typeof raw.meaning !== "string" || !meanings.has(raw.meaning as RelationMeaning)) {
      errors.push({ code: "unknown_meaning", subject: raw.id || relationKey(raw), detail: String(raw.meaning) });
      continue;
    }
    const meaning = raw.meaning as RelationMeaning;
    const role = raw.role;
    if (role !== undefined && (!rolePattern.test(role) || !roleSet.has(role))) {
      errors.push({ code: "unknown_role", subject: raw.id || relationKey(raw), detail: String(role) });
      continue;
    }
    const relation: SubjectRelation = {
      ...(raw.id ? { id: raw.id } : {}),
      meaning,
      ...(role ? { role } : {}),
      source,
      target,
    };
    const domainError = validateDomain(relation);
    if (domainError) {
      errors.push({ code: "invalid_domain", subject: raw.id || relationKey(relation), detail: domainError });
      continue;
    }

    for (const endpoint of [source, target]) {
      if (endpoint.kind === "relation") {
        if (!relationIds.has(endpoint.id))
          errors.push({ code: "missing_subject", subject: raw.id || relationKey(relation), detail: "relation:" + endpoint.id });
      } else if (!subjects.has(subjectRefKey(endpoint))) {
        errors.push({ code: "missing_subject", subject: raw.id || relationKey(relation), detail: subjectRefKey(endpoint) });
      }
    }

    const key = relationKey(relation);
    if (seen.has(key)) errors.push({ code: "duplicate_relation", subject: raw.id || key });
    else {
      seen.add(key);
      normalized.push(relation);
    }
  }

  const selections = [...(input.acyclic || [])].map(selection => ({
    meaning: selection.meaning,
    roles: [...new Set(selection.roles)].sort(),
  })).sort((a, b) => stable(a).localeCompare(stable(b), "en"));

  for (const selection of selections) {
    if (selection.meaning !== "depends_on" || selection.roles.length === 0 || selection.roles.some(role => !roleSet.has(role))) {
      errors.push({ code: "invalid_acyclic_selection", subject: stable(selection) });
      continue;
    }
    const cycle = selectedCycle(normalized, selection);
    if (cycle) errors.push({ code: "relation_cycle", subject: stable(selection), detail: cycle.join(" -> ") });
  }

  errors.sort((a, b) =>
    a.code.localeCompare(b.code, "en") ||
    a.subject.localeCompare(b.subject, "en") ||
    (a.detail || "").localeCompare(b.detail || "", "en"));
  normalized.sort((a, b) => relationKey(a).localeCompare(relationKey(b), "en") || (a.id || "").localeCompare(b.id || "", "en"));

  return {
    ok: errors.length === 0,
    subjects: [...subjects.values()].sort((a, b) => subjectRefKey(a).localeCompare(subjectRefKey(b), "en")),
    relations: normalized,
    errors,
  };
}

export function reverseImpact(
  relations: readonly SubjectRelation[],
  changed: SubjectRef,
  options: { roles?: readonly string[] } = {},
): SubjectRef[] {
  const roleSet = options.roles ? new Set(options.roles) : null;
  const start = subjectRefKey(changed);
  const refs = new Map<string, SubjectRef>([[start, normalizeSubjectRef(changed)]]);
  const reverse = new Map<string, SubjectRef[]>();

  for (const relation of relations) {
    if (relation.meaning !== "depends_on") continue;
    if (roleSet && (!relation.role || !roleSet.has(relation.role))) continue;
    const target = subjectRefKey(relation.target);
    const list = reverse.get(target) || [];
    list.push(normalizeSubjectRef(relation.source));
    reverse.set(target, list);
  }

  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const next = (reverse.get(current) || []).sort((a, b) => subjectRefKey(a).localeCompare(subjectRefKey(b), "en"));
    for (const ref of next) {
      const key = subjectRefKey(ref);
      if (refs.has(key)) continue;
      refs.set(key, ref);
      queue.push(key);
    }
  }
  return [...refs.values()].sort((a, b) => subjectRefKey(a).localeCompare(subjectRefKey(b), "en"));
}
