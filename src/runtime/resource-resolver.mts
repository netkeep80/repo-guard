import { normalizeDocumentFact, parseJson, parseYaml, resolveJsonPointer } from "../document-facts.mjs";
import { durablePointer, type CanonicalRequirementsResult, type ExactRepresentationSubject } from "./canonical-requirements.mjs";

export type ResourceRef =
  | { kind: "requirement"; id: string }
  | { kind: "artifact"; path: string }
  | { kind: "document"; path: string; pointer?: string }
  | { kind: "external_document"; repository: string; revision: string; path: string; pointer?: string };
export interface ResolverContext {
  repository: string;
  revision: string;
  requirements: CanonicalRequirementsResult;
  readers: Readonly<Record<string, (revision: string, path: string) => string | Buffer | null | undefined>>;
}
export interface ResolveError { code: string; subject: string; message: string; }
export type ResolveResult = { ok: true; value: unknown } | { ok: false; error: ResolveError };
const sha = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const definitions: Readonly<Record<ResourceRef["kind"], readonly string[]>> = {
  requirement: ["kind", "id"], artifact: ["kind", "path"],
  document: ["kind", "path", "pointer"], external_document: ["kind", "repository", "revision", "path", "pointer"],
};
const error = (code: string, subject: string, message: string): ResolveResult => ({ ok: false, error: { code, subject, message } });
const safePath = (p: unknown): string => {
  if (typeof p !== "string") throw new Error("repository path must be a string");
  const norm = normalizeDocumentFact(p, "repository_path");
  if (norm !== p) throw new Error("noncanonical repository path alias");
  return norm;
};
const exactIdentity = (repository: string, revision: string, path: string, pointer = ""): ExactRepresentationSubject =>
  ({ kind: "exact_representation", repository, revision, path, pointer });
function strictRef(value: unknown): ResourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ResourceRef object");
  const obj = value as Record<string, unknown>, kind = obj.kind;
  if (typeof kind !== "string" || !Object.hasOwn(definitions, kind)) throw new Error("unknown ResourceRef kind");
  const keys = definitions[kind as ResourceRef["kind"]];
  if (Object.keys(obj).some(k => !keys.includes(k))) throw new Error("extra ResourceRef fields forbidden");
  if (kind === "requirement") {
    if (typeof obj.id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(obj.id)) throw new Error("invalid RequirementId");
  } else {
    safePath(obj.path);
    if (kind !== "artifact" && obj.pointer !== undefined && typeof obj.pointer !== "string") throw new Error("invalid JSON pointer");
    if (kind === "external_document" &&
      (typeof obj.repository !== "string" || !repositoryPattern.test(obj.repository) ||
       typeof obj.revision !== "string" || !sha.test(obj.revision))) throw new Error("invalid external repository or revision");
  }
  return obj as unknown as ResourceRef;
}
function parsedDocument(raw: string, path: string): unknown {
  if (path.endsWith(".json")) return parseJson(raw);
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return parseYaml(raw);
  throw new Error("unsupported document format");
}
export function createResourceResolver(context: ResolverContext) {
  if (!repositoryPattern.test(context.repository) || !sha.test(context.revision)) throw new Error("resolver context requires exact repository and revision");
  if (!context.requirements.ok || context.requirements.requirements.some(r => r.representation.repository !== context.repository || r.representation.revision !== context.revision))
    throw new Error("inconsistent I1 exact snapshot");
  return {
    resolve(rawRef: unknown, options: { durable?: boolean; expectedRevision?: string } = {}): ResolveResult {
      let ref: ResourceRef;
      try { ref = strictRef(rawRef); }
      catch (e) { const message = (e as Error).message; return error(/path|noncanonical/i.test(message) ? "unsafe_path" : /invalid external repository or revision/.test(message) ? "invalid_revision" : "invalid_ref", "", message); }
      const subject = JSON.stringify(ref);
      if (ref.kind === "requirement") {
        const found = context.requirements.index[ref.id];
        if (!found || context.requirements.errors.length) return error("unknown_requirement", subject, "Requirement absent or ambiguous in exact I1 index");
        return { ok: true, value: { kind: "resolved_requirement", semantic: found.semantic, source: found.source, representation: found.representation, value: found.value } };
      }
      let repository = context.repository, revision = context.revision;
      if (ref.kind === "external_document") { repository = ref.repository; revision = ref.revision; }
      if (options.expectedRevision && revision !== options.expectedRevision)
        return error("inconsistent_snapshot", subject, "revision differs from expected exact snapshot");
      const reader = Object.hasOwn(context.readers, repository) ? context.readers[repository] : undefined;
      if (typeof reader !== "function") return error("unknown_repository", subject, "repository exact reader not registered");
      let path: string;
      try { path = safePath(ref.path); }
      catch (e) { return error("unsafe_path", subject, (e as Error).message); }
      const pointer = ref.kind === "artifact" ? "" : ref.pointer || "";
      if (pointer && (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)))
        return error("malformed_pointer", subject, "invalid JSON pointer");
      if (options.durable && !durablePointer(pointer))
        return error("non_durable_pointer", subject, "positional fragment cannot be durable identity");
      const identity = exactIdentity(repository, revision, path, pointer);
      try {
        const raw = reader(revision, path);
        if (raw === undefined || raw === null) return error("missing_path", subject, "exact snapshot path does not exist");
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (ref.kind === "artifact")
          return { ok: true, value: { kind: "resolved_artifact", representation: identity, bytes } };
        const document = parsedDocument(bytes.toString("utf8"), path);
        const value = resolveJsonPointer(document, pointer);
        return { ok: true, value: { kind: "resolved_document", representation: identity, value } };
      } catch (e) {
        const message = (e as Error).message;
        return error(/invalid json_pointer/.test(message) ? "malformed_pointer" :
          /does not exist/.test(message) ? "missing_fragment" : "invalid_document", subject, message);
      }
    }
  };
}
