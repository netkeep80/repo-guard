import type { RepositoryFactsInput } from "../facts/input.mjs";
import type { ParsedDiffFile } from "../diff/parser.mjs";
import { normalizeDocumentFact, resolveJsonPointer } from "../document-facts.mjs";
import { getExactDiffIdentity, listTrackedEntriesAtRef, readFileAtRef, runGit } from "../git.mjs";
import { canonicalSemanticDigest, durablePointer, exactRepresentationSubject, loadCanonicalRequirements, loadNativeRequirements, semanticRequirementSubject, type CanonicalError, type CanonicalRequirement, type CanonicalRequirementsResult, type NativeRequirementsResult, type SemanticRequirementSubject } from "./canonical-requirements.mjs";
import { evaluateRootedRequirements } from "./requirement-closure.mjs";
import { createResourceResolver } from "./resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "./resource-closure.mjs";
import { evaluateTransitionCauseClosure, resourceDeltasFromParsedDiff, type AuthenticatedProviderGrant, type TransitionEvidenceFact, type TransitionObservationFact, type TransitionReceipt, type WorkIntentFact } from "./transition-closure.mjs";
import { buildPolicyFacts } from "../facts/input.mjs";
import { runPolicyChecks } from "../checks/orchestrator.mjs";
import type { ExecutionPhase } from "../checks/rule-registry.mjs";
import { buildStateObligationPlan } from "../checks/state-obligation-plan.mjs";
import { compileChangeProfiles } from "../policy-compiler.mjs";
import { buildAnchorDiagnostics } from "../reporting/anchor-diagnostics.mjs";
import { createAnalysisCollector } from "./analysis-report.mjs";
import { createAnalysisTextPresenter, renderDiffAnalysis, renderEnforcementMode } from "../reporting/renderers.mjs";

interface InitialPolicyCheck { name: string; check: unknown; }
export interface PolicyPipelineInput extends RepositoryFactsInput { mode: string; initialChecks?: readonly InitialPolicyCheck[] | null; }
export interface PolicyPipelineOptions { shadowObservation?: (facts: ReturnType<typeof buildPolicyFacts>) => void;  quiet?: boolean; printEnforcement?: boolean; ruleNamePrefix?: string; excludeRuleFamilies?: readonly string[]; executionPhase?: ExecutionPhase; policyOrigin?: "base" | "head" | "shared"; satisfiedTransactionConstraintKeys?: readonly string[]; }
type AnalysisCollector = ReturnType<typeof createAnalysisCollector>;

export interface RepoGuardProjectionFact {
  requirementId: string; sourcePath: string; semanticDigest: string;
  artifactIndex: number; relationIndex: number; legacyPredicate: string; predicate: string; path: string;
}
export interface RepoGuardSelfHostInput {
  repository: string; repositoryRoot: string;
  trustedAuthorityBaseRevision: string; baseRevision: string; headRevision: string;
  observedTrackedPaths: readonly string[]; observedDiffFiles: readonly ParsedDiffFile[];
  workIntent?: WorkIntentFact | null;
  trustedReceipts?: readonly TransitionReceipt[];
  protectedResources?: readonly string[];
  evidenceFacts?: readonly TransitionEvidenceFact[];
  observationFacts?: readonly TransitionObservationFact[];
  trustedEvidenceProviders?: readonly string[];
  authenticatedProviderGrants?: readonly AuthenticatedProviderGrant[];
}
export interface RepoGuardSelfHostConfig extends Omit<RepoGuardSelfHostInput, "observedTrackedPaths" | "observedDiffFiles"> {}

const selfHostRootSource = "docs/product-requirements.md";
const selfHostProtectedResources = Object.freeze([selfHostRootSource, ".github/workflows/trusted-enforcement.yml"]);
const legacyPredicates: Readonly<Record<string, string>> = Object.freeze({
  requires: "requires", implements: "implemented_by", verifies: "verified_by", documents: "documents",
});
const exactSha = /^[0-9a-f]{40}$/;
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
const exactResourcePath = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("resource path must be a string");
  const normalized = normalizeDocumentFact(value, "repository_path");
  if (normalized !== value || /[*?\[\]{}]/.test(value) || value.endsWith("/")) throw new Error("noncanonical or wildcard resource path");
  return value;
};
const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);


export type RepoGuardSelfHostRepresentationKind = "legacy" | "native" | "mixed" | "unknown";

const repoGuardRootIds = Object.freeze(Array.from(
  { length: 8 },
  (_value, index) => "RG-" + String(index + 1).padStart(2, "0"),
));
const repoGuardLegacyRootPaths = Object.freeze(repoGuardRootIds.map((id) => "requirements/repo-guard/" + id + ".yaml"));
const repoGuardNativeRootPaths = Object.freeze(repoGuardRootIds.map((id) => "requirements/repo-guard/" + id + ".rg.yaml"));

export function classifyRepoGuardSelfHostRepresentation(repositoryRoot: string, revision: string) {
  if (!exactSha.test(revision)) return { kind: "unknown" as const, legacy: 0, native: 0, reasons: ["A1:invalid_revision"] };
  let paths: string[];
  try {
    paths = listTrackedEntriesAtRef(revision, repositoryRoot).map((entry) => entry.path);
  } catch (error) {
    return { kind: "unknown" as const, legacy: 0, native: 0, reasons: ["A1:representation_read_failed:" + (error as Error).message] };
  }
  const pathSet = new Set(paths);
  const legacy = repoGuardLegacyRootPaths.filter((path) => pathSet.has(path)).length;
  const native = repoGuardNativeRootPaths.filter((path) => pathSet.has(path)).length;
  const extraNativeRoots = paths.filter((path) =>
    /^requirements\/repo-guard\/RG-[0-9]{2}\.rg\.(?:yaml|json)$/.test(path) &&
    !repoGuardNativeRootPaths.includes(path as typeof repoGuardNativeRootPaths[number]));
  const exactLegacy = legacy === 8 && native === 0 && extraNativeRoots.length === 0;
  const exactNative = legacy === 0 && native === 8 && extraNativeRoots.length === 0;
  const kind: RepoGuardSelfHostRepresentationKind = exactLegacy ? "legacy" : exactNative ? "native" :
    legacy > 0 && native > 0 ? "mixed" : "unknown";
  const reasons = kind === "legacy" || kind === "native" ? [] : [
    "A1:representation_not_exact:legacy=" + legacy + ":native=" + native + ":extra_native=" + extraNativeRoots.length,
  ];
  return { kind, legacy, native, reasons, paths: { legacy: repoGuardLegacyRootPaths, native: repoGuardNativeRootPaths } };
}

export function selectRepoGuardAuthoritativeEvaluator(input: {
  baseRepresentation: RepoGuardSelfHostRepresentationKind;
  headRepresentation: RepoGuardSelfHostRepresentationKind;
  forwardAuthorized?: boolean;
  rollbackAuthorized?: boolean;
}) {
  const { baseRepresentation: base, headRepresentation: head } = input;
  if (base === "legacy" && head === "legacy")
    return { ok: true as const, evaluator: "legacy" as const, transition: "steady" as const };
  if (base === "native" && head === "native")
    return { ok: true as const, evaluator: "native" as const, transition: "steady" as const };
  if (base === "legacy" && head === "native" && input.forwardAuthorized === true)
    return { ok: true as const, evaluator: "native" as const, transition: "forward_cutover" as const };
  if (base === "native" && head === "legacy" && input.rollbackAuthorized === true)
    return { ok: true as const, evaluator: "legacy" as const, transition: "rollback" as const };
  const reason = base === "legacy" && head === "native" ? "A1:forward_cutover_authority_missing" :
    base === "native" && head === "legacy" ? "A1:rollback_authority_missing" :
    "A1:representation_mixed_or_unknown";
  return { ok: false as const, reason, baseRepresentation: base, headRepresentation: head };
}

export function lowerNativeRequirements(native: NativeRequirementsResult) {
  const errors: CanonicalError[] = native.errors.map(error => ({
    code: "invalid_canonical_source",
    path: error.path,
    message: "native:" + error.code + ":" + error.message,
    ...(error.otherPath ? { otherPath: error.otherPath } : {}),
  }));
  const requirements: CanonicalRequirement[] = [];
  const lifecycle: Record<string, Record<string, boolean>> = {};
  const resourceRelations: Array<{ from: string; kind: "generates"; to: string }> = [];
  const generatedSeen = new Set<string>();

  for (const item of native.requirements) {
    const relations: Record<string, unknown> = {};
    let relationIndex = 0;
    for (const relation of item.relations) {
      if (relation.predicate === "generates") {
        if (relation.source.kind !== "artifact" || relation.target.kind !== "artifact") {
          errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:invalid generates lowering" });
          continue;
        }
        const key = relation.source.path + "\0" + relation.target.path;
        if (generatedSeen.has(key)) {
          errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:duplicate global generates relation" });
          continue;
        }
        generatedSeen.add(key);
        resourceRelations.push({ from: relation.source.path, kind: "generates", to: relation.target.path });
        continue;
      }
      if (relation.source.kind !== "requirement" || relation.source.id !== item.id) {
        errors.push({ code: "invalid_canonical_source", path: item.source.path, message: "native:non-generates relation must originate from enclosing Requirement" });
        continue;
      }
      const label = "native_" + String(relationIndex++).padStart(6, "0");
      relations[label] = { predicate: relation.predicate, target: relation.target };
    }
    const constraints = item.constraints.map(constraint => ({
      id: constraint.id,
      activation: constraint.activation,
      relations: [...constraint.scope.relations],
      includeGenerated: constraint.scope.include_generated,
      ...(constraint.metric ? {
        metric: constraint.metric.key === "git.changed_lines" ? "changed_lines" :
          constraint.metric.key === "git.changed_resources" ? "changed_resources" : constraint.metric.key,
        max: constraint.metric.max,
      } : {}),
      ...(constraint.evidence ? {
        evidence: {
          kind: constraint.evidence.class,
          key: constraint.evidence.key,
          ...(constraint.evidence.verifier?.kind === "artifact" ? { verifierPath: constraint.evidence.verifier.path } : {}),
        },
      } : {}),
    }));
    const value = { id: item.id, normative: item.normative, relations, constraints } as CanonicalRequirement["value"];
    requirements.push({ ...item, value, semantic: item.semantic });
    lifecycle[item.id] = { ...item.lifecycle };
  }

  requirements.sort((a, b) => a.id.localeCompare(b.id, "en"));
  resourceRelations.sort((a, b) => a.from.localeCompare(b.from, "en") || a.to.localeCompare(b.to, "en"));
  errors.sort((a, b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
  const index: Record<string, CanonicalRequirement> = Object.create(null);
  for (const item of requirements) index[item.id] = item;
  const result: CanonicalRequirementsResult = {
    ok: errors.length === 0,
    requirements,
    index,
    errors,
    resolveFragment(id, pointer, options = {}) {
      const source = index[id];
      if (errors.length || !source) return { ok: false, error: { code: "missing_fragment", path: id, message: "native Requirement unavailable in invalid or incomplete lowering" } };
      if (options.durable && !durablePointer(pointer))
        return { ok: false, error: { code: "malformed_pointer", path: source.source.path, message: "positional pointer is not durable" } };
      try {
        const value = resolveJsonPointer(source.value, pointer) as CanonicalRequirement["value"];
        return {
          ok: true,
          value,
          identity: exactRepresentationSubject(source.semantic.repository, source.representation.revision, source.source.path, pointer),
        };
      } catch (error) {
        const message = (error as Error).message;
        return { ok: false, error: { code: /invalid json_pointer/i.test(message) ? "malformed_pointer" : "missing_fragment", path: source.source.path, message } };
      }
    },
  };
  return { requirements: result, lifecycle, resourceRelations };
}

export interface RepoGuardNativeBlockingSnapshotInput {
  repository: string;
  repositoryRoot: string;
  trustedAuthorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  workIntent?: WorkIntentFact | null;
  trustedReceipts?: readonly TransitionReceipt[];
  protectedResources?: readonly string[];
  evidenceFacts?: readonly TransitionEvidenceFact[];
  observationFacts?: readonly TransitionObservationFact[];
  authenticatedProviderGrants?: readonly AuthenticatedProviderGrant[];
}

function readRepoGuardNativeSnapshot(repository: string, revision: string, repositoryRoot: string) {
  const entries = listTrackedEntriesAtRef(revision, repositoryRoot);
  const nativePaths = entries.map((entry) => entry.path)
    .filter((path) => path.startsWith("requirements/") && /\.rg\.(?:yaml|json)$/.test(path))
    .sort((a, b) => a.localeCompare(b, "en"));
  const native = loadNativeRequirements({
    repository,
    revision,
    paths: nativePaths,
    readFile: (sha, path) => sha === revision ? readFileAtRef(sha, path, repositoryRoot) : null,
  });
  const lowered = lowerNativeRequirements(native);
  return { revision, entries, nativePaths, native, ...lowered };
}

function closeRepoGuardNativeSnapshot(
  repository: string,
  repositoryRoot: string,
  snapshot: ReturnType<typeof readRepoGuardNativeSnapshot>,
  trustedRoots: readonly SemanticRequirementSubject[],
) {
  const j2 = evaluateRootedRequirements({ requirements: snapshot.requirements, trustedRoots });
  let j1 = {
    ok: false,
    justified: [] as string[],
    unjustified: snapshot.entries.map((entry) => entry.path),
    errors: [{ code: "j2_not_rooted", path: "" }],
    explanations: {} as Record<string, string[]>,
    owners: {} as Record<string, string[]>,
  };
  if (snapshot.requirements.ok && j2.ok) {
    const resolver = createResourceResolver({
      repository,
      revision: snapshot.revision,
      requirements: snapshot.requirements,
      readers: {
        [repository]: (sha, path) =>
          sha === snapshot.revision ? readFileAtRef(sha, path, repositoryRoot) : null,
      },
    });
    j1 = evaluateTrackedResourceClosure({
      repository,
      revision: snapshot.revision,
      requirements: snapshot.requirements,
      j2,
      trackedPaths: snapshot.entries.map((entry) => entry.path),
      resourceRelations: snapshot.resourceRelations,
      resolver,
    });
  }
  return { ...snapshot, j2, j1 };
}

function exactReceiptAllows(
  input: Pick<RepoGuardNativeBlockingSnapshotInput, "trustedAuthorityBaseRevision" | "baseRevision" | "headRevision" | "trustedReceipts">,
  permission: string,
): boolean {
  return (input.trustedReceipts || []).some((receipt) =>
    receipt.authorityBaseRevision === input.trustedAuthorityBaseRevision &&
    receipt.baseRevision === input.baseRevision &&
    receipt.headRevision === input.headRevision &&
    Array.isArray(receipt.permissions) &&
    receipt.permissions.every((item) => typeof item === "string" && item.length > 0 && item !== "*" && !item.includes("*")) &&
    receipt.permissions.includes(permission));
}

function nativeRootsForHead(
  input: RepoGuardNativeBlockingSnapshotInput,
  authority: ReturnType<typeof readRepoGuardNativeSnapshot>,
  head: ReturnType<typeof readRepoGuardNativeSnapshot>,
): SemanticRequirementSubject[] {
  const accepted = new Map(authority.native.requirements.map((item) => [item.id, item.semantic]));
  const roots: SemanticRequirementSubject[] = [];
  for (const item of head.native.requirements) {
    const prior = accepted.get(item.id);
    if (prior && semanticSubjectKey(prior) === semanticSubjectKey(item.semantic)) {
      roots.push(prior);
      continue;
    }
    if (exactReceiptAllows(input, "requirement:" + item.id)) roots.push(item.semantic);
  }
  return roots.sort((a, b) => a.requirementId.localeCompare(b.requirementId, "en"));
}

export function evaluateRepoGuardNativeBlockingSnapshot(input: RepoGuardNativeBlockingSnapshotInput) {
  const reasons: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    reasons.push("A1:native_invalid_repository");
  for (const [label, revision] of [
    ["authority", input.trustedAuthorityBaseRevision],
    ["base", input.baseRevision],
    ["head", input.headRevision],
  ] as const) if (!exactSha.test(revision)) reasons.push("A1:native_invalid_" + label + "_revision");

  if (reasons.length) {
    return {
      ok: false,
      reasons: uniqueSorted(reasons),
      providerCapabilityMode: true,
      j2: { rooted: 0, unrooted: 0 },
      j1: { tracked: 0, justified: 0, unjustified: 0 },
      j3: { ok: false, reasons: ["A1:native_input_invalid"] },
    };
  }

  let authorityRaw: ReturnType<typeof readRepoGuardNativeSnapshot>;
  let baseRaw: ReturnType<typeof readRepoGuardNativeSnapshot>;
  let headRaw: ReturnType<typeof readRepoGuardNativeSnapshot>;
  try {
    authorityRaw = readRepoGuardNativeSnapshot(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot);
    baseRaw = input.baseRevision === input.trustedAuthorityBaseRevision
      ? authorityRaw
      : readRepoGuardNativeSnapshot(input.repository, input.baseRevision, input.repositoryRoot);
    headRaw = input.headRevision === input.baseRevision
      ? baseRaw
      : input.headRevision === input.trustedAuthorityBaseRevision
        ? authorityRaw
        : readRepoGuardNativeSnapshot(input.repository, input.headRevision, input.repositoryRoot);
  } catch (error) {
    return {
      ok: false,
      reasons: ["A1:native_snapshot_read_failed:" + (error as Error).message],
      providerCapabilityMode: true,
      j2: { rooted: 0, unrooted: 0 },
      j1: { tracked: 0, justified: 0, unjustified: 0 },
      j3: { ok: false, reasons: ["A1:native_snapshot_read_failed"] },
    };
  }

  if (classifyRepoGuardSelfHostRepresentation(input.repositoryRoot, input.trustedAuthorityBaseRevision).kind !== "native")
    reasons.push("A1:authority_not_native");
  if (classifyRepoGuardSelfHostRepresentation(input.repositoryRoot, input.baseRevision).kind !== "native")
    reasons.push("A1:base_not_native");
  if (classifyRepoGuardSelfHostRepresentation(input.repositoryRoot, input.headRevision).kind !== "native")
    reasons.push("A1:head_not_native");

  const authorityRoots = authorityRaw.native.requirements.map((item) => item.semantic);
  const authority = closeRepoGuardNativeSnapshot(input.repository, input.repositoryRoot, authorityRaw, authorityRoots);
  const base = closeRepoGuardNativeSnapshot(input.repository, input.repositoryRoot, baseRaw, authorityRoots);
  const headRoots = nativeRootsForHead(input, authorityRaw, headRaw);
  const head = closeRepoGuardNativeSnapshot(input.repository, input.repositoryRoot, headRaw, headRoots);

  for (const [label, state] of [["authority", authority], ["base", base], ["head", head]] as const) {
    if (!state.requirements.ok) reasons.push("A1:" + label + "_native_requirements_invalid");
    if (!state.j2.ok) reasons.push("A1:" + label + "_j2_not_rooted");
    if (!state.j1.ok) reasons.push("A1:" + label + "_j1_not_closed");
  }

  let exactDiff: ParsedDiffFile[] = [];
  try {
    exactDiff = getExactDiffIdentity(input.baseRevision, input.headRevision, input.repositoryRoot);
  } catch (error) {
    reasons.push("A1:native_diff_failed:" + (error as Error).message);
  }

  // Native production always supplies this field, including the empty set.
  // This makes the legacy generic-provider fallback structurally unreachable.
  const authenticatedProviderGrants = [...(input.authenticatedProviderGrants || [])];

  const transition = evaluateTransitionCauseClosure({
    repository: input.repository,
    base: {
      revision: base.revision,
      requirements: base.requirements,
      j2: base.j2,
      j1: base.j1,
      resourceRelations: base.resourceRelations,
    },
    head: {
      revision: head.revision,
      requirements: head.requirements,
      j2: head.j2,
      j1: head.j1,
      resourceRelations: head.resourceRelations,
    },
    trustedAuthorityBase: {
      revision: authority.revision,
      requirements: authority.requirements,
      j2: authority.j2,
      resourceRelations: authority.resourceRelations,
    },
    resourceDeltas: resourceDeltasFromParsedDiff(exactDiff),
    baseLifecycle: base.lifecycle,
    headLifecycle: head.lifecycle,
    workIntent: input.workIntent || null,
    trustedReceipts: input.trustedReceipts || [],
    protectedResources: uniqueSorted([...selfHostProtectedResources, ...(input.protectedResources || [])]),
    evidenceFacts: input.evidenceFacts || [],
    observationFacts: input.observationFacts || [],
    authenticatedProviderGrants,
  });
  reasons.push(...transition.reasons.map((reason) => "A1:" + reason));

  const normalizedReasons = uniqueSorted(reasons);
  return {
    ok: normalizedReasons.length === 0,
    reasons: normalizedReasons,
    providerCapabilityMode: true,
    authenticatedProviderGrantCount: authenticatedProviderGrants.length,
    authority: {
      revision: authority.revision,
      nativeRequirements: authority.native.requirements.length,
      rooted: authority.j2.rooted,
    },
    base: {
      revision: base.revision,
      nativeRequirements: base.native.requirements.length,
      rooted: base.j2.rooted,
      tracked: base.entries.length,
      justified: base.j1.justified.length,
    },
    head: {
      revision: head.revision,
      nativeRequirements: head.native.requirements.length,
      rooted: head.j2.rooted,
      tracked: head.entries.length,
      justified: head.j1.justified.length,
    },
    j2: { rooted: head.j2.rooted.length, unrooted: head.j2.unrooted.length },
    j1: { tracked: head.entries.length, justified: head.j1.justified.length, unjustified: head.j1.unjustified.length },
    j3: { ok: transition.ok, reasons: transition.reasons, deltas: transition.deltas, explanations: transition.explanations },
    constraints: transition.explanations.constraints,
    transition,
  };
}

export function projectRepoGuardLegacyRequirements(
  raw: CanonicalRequirementsResult,
  implicitSourcePaths: Readonly<Record<string, string>> = Object.fromEntries(raw.requirements.map((item) => [item.id, item.source.path])),
  authoritySubjects: Readonly<Record<string, SemanticRequirementSubject>> = Object.fromEntries(raw.requirements.map((item) => [item.id, item.semantic])),
) {
  const projectionErrors: CanonicalError[] = [];
  const facts: RepoGuardProjectionFact[] = [];
  const projected: CanonicalRequirement[] = [];
  for (const item of raw.requirements) {
    const root = object(item.value);
    const artifacts = root.artifacts;
    const allowedRoot = Object.keys(root).every((key) => key === "id" || key === "artifacts");
    if (!allowedRoot || root.id !== item.id || !Array.isArray(artifacts)) {
      projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: "I8 legacy projection requires exact id + artifacts shape" });
      continue;
    }
    const relations: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (let artifactIndex = 0; artifactIndex < artifacts.length; artifactIndex++) {
      const artifact = object(artifacts[artifactIndex]);
      if (Object.keys(artifact).sort().join(",") !== "path,relations" || !Array.isArray(artifact.relations)) {
        projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 invalid legacy artifact entry ${artifactIndex}` });
        continue;
      }
      let path: string;
      try { path = exactResourcePath(artifact.path); }
      catch (error) {
        projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 artifact ${artifactIndex}: ${(error as Error).message}` });
        continue;
      }
      for (let relationIndex = 0; relationIndex < artifact.relations.length; relationIndex++) {
        const legacy = artifact.relations[relationIndex];
        if (typeof legacy !== "string" || !Object.hasOwn(legacyPredicates, legacy)) {
          projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 unsupported legacy predicate ${String(legacy)}` });
          continue;
        }
        const predicate = legacyPredicates[legacy]!;
        const identity = JSON.stringify([predicate, path]);
        if (seen.has(identity)) {
          projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 duplicate projected relation ${predicate}:${path}` });
          continue;
        }
        seen.add(identity);
        const implicitSourcePath = implicitSourcePaths[item.id] || item.source.path;
        if (legacy === "requires" && path === implicitSourcePath) continue;
        const label = `legacy_${String(artifactIndex).padStart(4, "0")}_${String(relationIndex).padStart(2, "0")}`;
        relations[label] = { predicate, target: { kind: "artifact", path } };
        facts.push({
          requirementId: item.id, sourcePath: item.source.path, semanticDigest: item.semantic.digest,
          artifactIndex, relationIndex, legacyPredicate: legacy, predicate, path,
        });
      }
    }
    const authoritySubject = authoritySubjects[item.id];
    if (!authoritySubject || authoritySubject.repository !== item.semantic.repository || authoritySubject.requirementId !== item.id) {
      projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 missing or mismatched normative authority subject for ${item.id}` });
      continue;
    }
    const value = {
      id: item.id,
      authority: { source: selfHostRootSource, digest: authoritySubject.digest },
      relations,
    } as CanonicalRequirement["value"];
    projected.push({
      ...item,
      value,
      semantic: semanticRequirementSubject(item.semantic.repository, item.id, canonicalSemanticDigest(value)),
    });
  }
  const errors = [...raw.errors, ...projectionErrors].sort((a, b) =>
    a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
  const requirements = projected.sort((a, b) => a.id.localeCompare(b.id, "en"));
  const index: Record<string, CanonicalRequirement> = Object.create(null);
  for (const item of requirements) index[item.id] = item;
  const result: CanonicalRequirementsResult = {
    ok: raw.ok && projectionErrors.length === 0,
    requirements, index, errors,
    resolveFragment: raw.resolveFragment,
  };
  return { requirements: result, facts: facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), errors: projectionErrors };
}

function acceptedRootAuthority(repository: string, revision: string, repositoryRoot: string) {
  const raw = readFileAtRef(revision, selfHostRootSource, repositoryRoot);
  if (raw === null) throw new Error("I8 accepted root source missing");
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^###\s+(RG-[0-9]{2})\s+—/);
    if (match) {
      current = match[1]!;
      if (sections.has(current)) throw new Error(`I8 accepted root source has duplicate ${current} heading`);
      sections.set(current, [line]);
      continue;
    }
    if (current && /^#{1,3}\s+/.test(line)) current = null;
    if (current) sections.get(current)!.push(line);
  }
  const ids = [...sections.keys()].sort((a, b) => a.localeCompare(b, "en"));
  if (!ids.length) throw new Error("I8 accepted root source has no RG headings");
  const subjects: Record<string, SemanticRequirementSubject> = Object.create(null);
  const texts: Record<string, string> = Object.create(null);
  for (const id of ids) {
    const text = sections.get(id)!.join("\n");
    texts[id] = text;
    const value = { id, source: selfHostRootSource, text } as CanonicalRequirement["value"];
    subjects[id] = semanticRequirementSubject(repository, id, canonicalSemanticDigest(value));
  }
  return { ids, subjects, texts };
}

function loadRepoGuardProjection(
  repository: string,
  revision: string,
  repositoryRoot: string,
  implicitSourcePaths?: Readonly<Record<string, string>>,
) {
  if (!exactSha.test(revision)) throw new Error("I8 exact revision must be 40 lowercase hex");
  const entries = listTrackedEntriesAtRef(revision, repositoryRoot);
  const canonicalPaths = entries.map((entry) => entry.path)
    .filter((path) => path.startsWith("requirements/") && /\.(?:yaml|yml|json)$/.test(path));
  const raw = loadCanonicalRequirements({
    repository, revision, paths: canonicalPaths,
    readFile: (sha, path) => readFileAtRef(sha, path, repositoryRoot),
  });
  const rootAuthority = acceptedRootAuthority(repository, revision, repositoryRoot);
  const projection = projectRepoGuardLegacyRequirements(raw, implicitSourcePaths, rootAuthority.subjects);
  return { entries, raw, rootIds: rootAuthority.ids, rootSubjects: rootAuthority.subjects, rootTexts: rootAuthority.texts, ...projection };
}

function closeRepoGuardProjection(
  repository: string, revision: string, repositoryRoot: string,
  loaded: ReturnType<typeof loadRepoGuardProjection>, trustedRoots: readonly SemanticRequirementSubject[],
) {
  const j2 = evaluateRootedRequirements({ requirements: loaded.requirements, trustedRoots, rootSubjects: loaded.rootSubjects });
  let j1 = {
    ok: false, justified: [] as string[], unjustified: loaded.entries.map((entry) => entry.path),
    errors: [{ code: "j2_not_rooted", path: "" }], explanations: {} as Record<string, string[]>,
    owners: {} as Record<string, string[]>,
  };
  if (loaded.requirements.ok && j2.ok) {
    const exactPaths = new Set(loaded.entries.map((entry) => entry.path));
    const resolver = createResourceResolver({
      repository, revision, requirements: loaded.requirements,
      readers: { [repository]: (sha, path) => sha === revision && exactPaths.has(path) ? Buffer.alloc(0) : null },
    });
    j1 = evaluateTrackedResourceClosure({
      repository, revision, requirements: loaded.requirements, j2,
      trackedPaths: loaded.entries.map((entry) => entry.path), resolver,
    });
  }
  return { revision, requirements: loaded.requirements, j2, j1, entries: loaded.entries, projectionFacts: loaded.facts };
}


export interface RepoGuardNativeSelfHostShadowSnapshotInput {
  repository: string;
  revision: string;
  repositoryRoot: string;
}

const nativeShadowPredicates: Readonly<Record<string, "implemented_by" | "verified_by" | "documents">> = Object.freeze({
  implements: "implemented_by",
  verifies: "verified_by",
  documents: "documents",
});

function nativeShadowSourcePath(id: string): string {
  return "requirements/repo-guard/" + id + ".rg.yaml";
}

function buildRepoGuardNativeShadowSources(
  loaded: ReturnType<typeof loadRepoGuardProjection>,
): {
  sources: Map<string, string>;
  from: string[];
  to: string[];
  errors: string[];
} {
  const sources = new Map<string, string>();
  const from: string[] = [];
  const to: string[] = [];
  const errors: string[] = [];
  const ids = loaded.rootIds;

  for (const id of ids) {
    const item = loaded.raw.index[id];
    const text = loaded.rootTexts[id];
    if (!item || typeof text !== "string") {
      errors.push("C2.4:missing_native_shadow_input:" + id);
      continue;
    }
    const root = object(item.value);
    const artifacts = root.artifacts;
    if (!Array.isArray(artifacts)) {
      errors.push("C2.4:invalid_legacy_artifacts:" + id);
      continue;
    }
    const grouped = new Map<string, Set<string>>();
    for (let index = 0; index < artifacts.length; index++) {
      const artifact = object(artifacts[index]);
      if (!artifact || typeof artifact.path !== "string" || !Array.isArray(artifact.relations)) {
        errors.push("C2.4:invalid_legacy_artifact:" + id + ":" + index);
        continue;
      }
      let path: string;
      try { path = exactResourcePath(artifact.path); }
      catch {
        errors.push("C2.4:unsafe_legacy_artifact:" + id + ":" + index);
        continue;
      }
      const predicates = new Set<string>();
      let requires = false;
      for (const rawPredicate of artifact.relations) {
        if (rawPredicate === "requires") {
          requires = true;
          continue;
        }
        if (typeof rawPredicate !== "string" || !Object.hasOwn(nativeShadowPredicates, rawPredicate)) {
          errors.push("C2.4:unsupported_legacy_predicate:" + id + ":" + String(rawPredicate));
          continue;
        }
        predicates.add(nativeShadowPredicates[rawPredicate]!);
      }
      if (!predicates.size) {
        if (!(requires && path === item.source.path))
          errors.push("C2.4:unmapped_requires_only:" + id + ":" + path);
        continue;
      }
      const target = grouped.get(path) || new Set<string>();
      for (const predicate of predicates) target.add(predicate);
      grouped.set(path, target);
    }

    const nativePath = nativeShadowSourcePath(id);
    const lines = [
      "format: repo-guard/requirement-v1",
      "id: " + id,
      "normative: " + JSON.stringify(text),
    ];
    if (grouped.size) lines.push("relations:");
    for (const path of [...grouped.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
      const predicates = [...grouped.get(path)!].sort((a, b) => a.localeCompare(b, "en"));
      lines.push(
        "  - predicates: [" + predicates.join(", ") + "]",
        "    target:",
        "      kind: artifact",
        "      path: " + JSON.stringify(path),
      );
    }
    lines.push("");
    sources.set(nativePath, lines.join("\n"));
    from.push(item.source.path);
    to.push(nativePath);
  }
  return { sources, from: from.sort(), to: to.sort(), errors: uniqueSorted(errors) };
}

export function evaluateRepoGuardNativeSelfHostShadowSnapshot(input: RepoGuardNativeSelfHostShadowSnapshotInput) {
  const reasons: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    reasons.push("C2.4:invalid_repository");
  if (!exactSha.test(input.revision))
    reasons.push("C2.4:invalid_revision");

  const loaded = loadRepoGuardProjection(input.repository, input.revision, input.repositoryRoot);
  const legacyRoots = loaded.rootIds.flatMap((id) => loaded.rootSubjects[id] ? [loaded.rootSubjects[id]!] : []);
  const legacy = closeRepoGuardProjection(input.repository, input.revision, input.repositoryRoot, loaded, legacyRoots);
  if (loaded.errors.length) reasons.push("C2.4:legacy_projection_invalid");
  if (!legacy.j2.ok) reasons.push("C2.4:legacy_j2_not_rooted");
  if (!legacy.j1.ok) reasons.push("C2.4:legacy_j1_not_closed");

  const generated = buildRepoGuardNativeShadowSources(loaded);
  reasons.push(...generated.errors);
  const native = loadNativeRequirements({
    repository: input.repository,
    revision: input.revision,
    paths: generated.to,
    readFile: (revision, path) =>
      revision === input.revision && generated.sources.has(path) ? generated.sources.get(path)! : null,
  });
  if (!native.ok) reasons.push(...native.errors.map((error) => "C2.4:native:" + error.code + ":" + error.path));
  const lowered = lowerNativeRequirements(native);
  const candidateRoots = native.requirements.map((item) => item.semantic);
  const j2 = evaluateRootedRequirements({ requirements: lowered.requirements, trustedRoots: candidateRoots });

  const legacySources = new Set(generated.from);
  const virtualTracked = uniqueSorted([
    ...loaded.entries.map((entry) => entry.path).filter((path) => !legacySources.has(path)),
    ...generated.to,
  ]);
  const virtualSourceSet = new Set(generated.to);
  const resolver = createResourceResolver({
    repository: input.repository,
    revision: input.revision,
    requirements: lowered.requirements,
    readers: {
      [input.repository]: (revision, path) => {
        if (revision !== input.revision) return null;
        if (virtualSourceSet.has(path)) return generated.sources.get(path) || null;
        return readFileAtRef(revision, path, input.repositoryRoot);
      },
    },
  });
  const j1 = evaluateTrackedResourceClosure({
    repository: input.repository,
    revision: input.revision,
    requirements: lowered.requirements,
    j2,
    trackedPaths: virtualTracked,
    resourceRelations: lowered.resourceRelations,
    resolver,
  });
  if (!j2.ok) reasons.push("C2.4:native_j2_not_rooted");
  if (!j1.ok) reasons.push("C2.4:native_j1_not_closed");

  const normativeExact = loaded.rootIds.every((id) =>
    native.index[id] !== undefined &&
    typeof loaded.rootTexts[id] === "string" &&
    native.index[id]!.normative === loaded.rootTexts[id]);
  if (!normativeExact) reasons.push("C2.4:normative_not_exact");

  const retained = loaded.entries.map((entry) => entry.path).filter((path) => !legacySources.has(path)).sort();
  const ownerEquivalentOnRetainedResources = retained.every((path) =>
    sameStrings([...(legacy.j1.owners[path] || [])].sort(), [...(j1.owners[path] || [])].sort()));
  if (!ownerEquivalentOnRetainedResources) reasons.push("C2.4:owner_mismatch");

  const relationCounts = { implemented_by: 0, verified_by: 0, documents: 0, total: 0 };
  let blanketRequiresProjected = 0;
  for (const requirement of native.requirements) {
    for (const relation of requirement.relations) {
      if (relation.predicate === "requires") blanketRequiresProjected++;
      if (relation.predicate === "implemented_by") relationCounts.implemented_by++;
      if (relation.predicate === "verified_by") relationCounts.verified_by++;
      if (relation.predicate === "documents") relationCounts.documents++;
    }
  }
  relationCounts.total = relationCounts.implemented_by + relationCounts.verified_by + relationCounts.documents;
  if (blanketRequiresProjected !== 0) reasons.push("C2.4:blanket_requires_projected");

  const subjectKey = (subject: SemanticRequirementSubject | undefined): string =>
    subject ? [subject.repository, subject.requirementId, subject.digest].join("\0") : "";
  const rootIdentityChanges = loaded.rootIds.filter((id) =>
    subjectKey(loaded.rootSubjects[id]) !== subjectKey(native.index[id]?.semantic)).length;
  const sharedOwnershipPaths = Object.values(j1.owners).filter((owners) => owners.length > 1).length;

  const normalizedReasons = uniqueSorted(reasons);
  return {
    ok: normalizedReasons.length === 0,
    reasons: normalizedReasons,
    revision: input.revision,
    acceptedAuthorityVerified: false,
    blockingCutoverEligible: false,
    rootMigrationRequired: true,
    legacy: {
      tracked: loaded.entries.length,
      justified: legacy.j1.justified.length,
      rooted: legacy.j2.rooted.length,
    },
    native: {
      tracked: virtualTracked.length,
      justified: j1.justified.length,
      rooted: j2.rooted.length,
      unrooted: j2.unrooted.length,
      candidateRoots,
    },
    equivalence: {
      normativeExact,
      ownerEquivalentOnRetainedResources,
      sharedOwnershipPaths,
      relationCounts,
      blanketRequiresProjected,
      rootIdentityChanges,
    },
    sourceMigration: { from: generated.from, to: generated.to },
  };
}

export interface RepoGuardTrustedRootMigrationReceipt extends TransitionReceipt {
  repository: string;
}

export interface RepoGuardTrustedRootMigrationSnapshotInput {
  repository: string;
  repositoryRoot: string;
  trustedAuthorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  trustedRootReceipt?: RepoGuardTrustedRootMigrationReceipt | null;
}

const semanticSubjectKey = (subject: SemanticRequirementSubject | undefined): string =>
  subject ? [subject.repository, subject.requirementId, subject.digest].join("\0") : "";

const rootMigrationPermission = (
  id: string,
  oldSubject: SemanticRequirementSubject,
  newSubject: SemanticRequirementSubject,
): string => "trusted_root:" + id + ":" + oldSubject.digest + ":" + newSubject.digest;

export function evaluateRepoGuardTrustedRootMigrationSnapshot(input: RepoGuardTrustedRootMigrationSnapshotInput) {
  const candidateReasons: string[] = [];
  const trustReasons: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    candidateReasons.push("C2.5:invalid_repository");
  for (const [label, revision] of [
    ["authority", input.trustedAuthorityBaseRevision],
    ["base", input.baseRevision],
    ["head", input.headRevision],
  ] as const) if (!exactSha.test(revision)) candidateReasons.push("C2.5:invalid_" + label + "_revision");

  try {
    const mergeBase = runGit(["merge-base", input.baseRevision, input.headRevision], { cwd: input.repositoryRoot }).trim();
    if (mergeBase !== input.baseRevision) candidateReasons.push("C2.5:base_not_ancestor");
  } catch {
    candidateReasons.push("C2.5:base_not_ancestor");
  }

  let authorityLoaded: ReturnType<typeof loadRepoGuardProjection>;
  let baseLoaded: ReturnType<typeof loadRepoGuardProjection>;
  try {
    authorityLoaded = loadRepoGuardProjection(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot);
    const acceptedSourcePaths = Object.fromEntries(
      authorityLoaded.raw.requirements.map((item) => [item.id, item.source.path]),
    );
    baseLoaded = input.baseRevision === input.trustedAuthorityBaseRevision
      ? authorityLoaded
      : loadRepoGuardProjection(input.repository, input.baseRevision, input.repositoryRoot, acceptedSourcePaths);
  } catch (error) {
    return {
      ok: false,
      candidateReady: false,
      reasons: ["C2.5:legacy_snapshot_invalid:" + (error as Error).message],
      trust: { authorized: false },
      blockingCutoverEligible: false,
      requiredPermissions: [] as string[],
      migration: [] as unknown[],
      equivalence: {
        normativeExact: false, normativeDigestExact: false, ownerEquivalentOnRetainedResources: false,
        rootIdentityChanges: 0, sharedOwnershipPaths: 0,
        relationCounts: { implemented_by: 0, verified_by: 0, documents: 0, total: 0 },
        blanketRequiresProjected: 0,
      },
      authorized: {
        j2: { rooted: [] as string[], unrooted: [] as string[] },
        j1: { tracked: 0, justified: 0, unjustified: 0 },
      },
    };
  }

  const expectedIds = Array.from({ length: 8 }, (_, index) => "RG-" + String(index + 1).padStart(2, "0"));
  if (!sameStrings(authorityLoaded.rootIds, expectedIds))
    candidateReasons.push("C2.5:accepted_root_set_mismatch");
  if (authorityLoaded.errors.length || baseLoaded.errors.length)
    candidateReasons.push("C2.5:legacy_projection_invalid");

  const oldRoots = expectedIds.flatMap((id) =>
    authorityLoaded.rootSubjects[id] ? [authorityLoaded.rootSubjects[id]!] : []);
  if (oldRoots.length !== 8) candidateReasons.push("C2.5:old_root_missing");

  const baseRootStable = expectedIds.every((id) =>
    semanticSubjectKey(authorityLoaded.rootSubjects[id]) === semanticSubjectKey(baseLoaded.rootSubjects[id]));
  if (!baseRootStable) candidateReasons.push("C2.5:base_root_stale");

  const baseState = closeRepoGuardProjection(
    input.repository, input.baseRevision, input.repositoryRoot, baseLoaded, oldRoots,
  );
  if (!baseState.j2.ok) candidateReasons.push("C2.5:base_j2_not_rooted");
  if (!baseState.j1.ok) candidateReasons.push("C2.5:base_j1_not_closed");

  const headEntries = listTrackedEntriesAtRef(input.headRevision, input.repositoryRoot);
  const expectedOldPaths = expectedIds.map((id) => "requirements/repo-guard/" + id + ".yaml");
  const expectedNativePaths = expectedIds.map(nativeShadowSourcePath);
  const actualNativePaths = headEntries.map((entry) => entry.path)
    .filter((path) => path.startsWith("requirements/") && /\.rg\.(?:yaml|json)$/.test(path))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (!sameStrings(actualNativePaths, expectedNativePaths))
    candidateReasons.push("C2.5:native_source_set_mismatch");
  if (expectedOldPaths.some((path) => headEntries.some((entry) => entry.path === path)))
    candidateReasons.push("C2.5:legacy_source_still_active");
  if (baseState.entries.length !== 359 || headEntries.length !== 359)
    candidateReasons.push("C2.5:tracked_count_mismatch");

  try {
    const migrationDiff = getExactDiffIdentity(input.baseRevision, input.headRevision, input.repositoryRoot);
    const actual = migrationDiff
      .map((file) => JSON.stringify([file.status, file.previousPath || "", file.path]))
      .sort();
    const expected = [
      ...expectedOldPaths.map((path) => JSON.stringify(["deleted", "", path])),
      ...expectedNativePaths.map((path) => JSON.stringify(["added", "", path])),
    ].sort();
    if (!sameStrings(actual, expected)) candidateReasons.push("C2.5:migration_diff_not_exact");
  } catch {
    candidateReasons.push("C2.5:migration_diff_not_exact");
  }

  const native = loadNativeRequirements({
    repository: input.repository,
    revision: input.headRevision,
    paths: actualNativePaths,
    readFile: (revision, path) =>
      revision === input.headRevision ? readFileAtRef(revision, path, input.repositoryRoot) : null,
  });
  if (!native.ok || native.requirements.length !== 8)
    candidateReasons.push("C2.5:native_invalid");

  const lowered = lowerNativeRequirements(native);
  const candidateRoots = native.requirements.map((item) => item.semantic);
  const candidateJ2 = evaluateRootedRequirements({
    requirements: lowered.requirements,
    trustedRoots: candidateRoots,
  });

  const emptyJ1 = {
    ok: false,
    justified: [] as string[],
    unjustified: headEntries.map((entry) => entry.path),
    owners: {} as Record<string, string[]>,
  };
  let candidateJ1 = emptyJ1;
  if (native.ok && candidateJ2.ok) {
    const headPaths = new Set(headEntries.map((entry) => entry.path));
    const resolver = createResourceResolver({
      repository: input.repository,
      revision: input.headRevision,
      requirements: lowered.requirements,
      readers: {
        [input.repository]: (revision, path) =>
          revision === input.headRevision && headPaths.has(path)
            ? readFileAtRef(revision, path, input.repositoryRoot) : null,
      },
    });
    candidateJ1 = evaluateTrackedResourceClosure({
      repository: input.repository,
      revision: input.headRevision,
      requirements: lowered.requirements,
      j2: candidateJ2,
      trackedPaths: headEntries.map((entry) => entry.path),
      resourceRelations: lowered.resourceRelations,
      resolver,
    });
  }
  if (!candidateJ2.ok) candidateReasons.push("C2.5:candidate_j2_not_rooted");
  if (!candidateJ1.ok) candidateReasons.push("C2.5:native_j1_not_closed");

  const migration = expectedIds.flatMap((id) => {
    const oldTrustedSubject = authorityLoaded.rootSubjects[id];
    const nativeRequirement = native.index[id];
    const rootText = authorityLoaded.rootTexts[id];
    const legacyRequirement = baseLoaded.raw.index[id];
    if (!oldTrustedSubject || !nativeRequirement || typeof rootText !== "string" || !legacyRequirement) return [];
    const normativeDigest = canonicalSemanticDigest(rootText);
    return [{
      requirementId: id,
      normativeDigest,
      oldTrustedSubject,
      newTrustedSubject: nativeRequirement.semantic,
      legacyRootSource: {
        repository: input.repository,
        revision: input.trustedAuthorityBaseRevision,
        path: selfHostRootSource,
        selector: "heading:" + id,
      },
      legacyRepresentation: legacyRequirement.representation,
      nativeRepresentation: nativeRequirement.representation,
      sourceMigration: { from: legacyRequirement.source.path, to: nativeRequirement.source.path },
      permission: rootMigrationPermission(id, oldTrustedSubject, nativeRequirement.semantic),
    }];
  });

  const normativeExact = expectedIds.every((id) =>
    native.index[id] !== undefined &&
    typeof authorityLoaded.rootTexts[id] === "string" &&
    native.index[id]!.normative === authorityLoaded.rootTexts[id]);
  const normativeDigestExact = migration.length === 8 && migration.every((item) =>
    item.normativeDigest === item.newTrustedSubject.digest);
  if (!normativeExact || !normativeDigestExact)
    candidateReasons.push("C2.5:normative_mismatch");

  const oldSubjectKeys = migration.map((item) => semanticSubjectKey(item.oldTrustedSubject));
  const newSubjectKeys = migration.map((item) => semanticSubjectKey(item.newTrustedSubject));
  const rootIdentityChanges = migration.filter((item) =>
    semanticSubjectKey(item.oldTrustedSubject) !== semanticSubjectKey(item.newTrustedSubject)).length;
  if (migration.length !== 8 || new Set(oldSubjectKeys).size !== 8 || new Set(newSubjectKeys).size !== 8)
    candidateReasons.push("C2.5:root_alias_or_duplicate");
  if (rootIdentityChanges !== 8) candidateReasons.push("C2.5:root_identity_change_count");

  const relationCounts = { implemented_by: 0, verified_by: 0, documents: 0, total: 0 };
  let blanketRequiresProjected = 0;
  for (const requirement of native.requirements) {
    for (const relation of requirement.relations) {
      if (relation.predicate === "requires") blanketRequiresProjected++;
      if (relation.predicate === "implemented_by") relationCounts.implemented_by++;
      if (relation.predicate === "verified_by") relationCounts.verified_by++;
      if (relation.predicate === "documents") relationCounts.documents++;
    }
  }
  relationCounts.total = relationCounts.implemented_by + relationCounts.verified_by + relationCounts.documents;
  if (relationCounts.implemented_by !== 143 || relationCounts.verified_by !== 169 ||
      relationCounts.documents !== 50 || relationCounts.total !== 362)
    candidateReasons.push("C2.5:relation_count_mismatch");
  if (blanketRequiresProjected !== 0)
    candidateReasons.push("C2.5:blanket_requires_projected");

  const unexpectedCutoverSemantics = native.requirements.some((requirement) =>
    requirement.constraints.length > 0 ||
    requirement.lifecycle.accepted || requirement.lifecycle.current || requirement.lifecycle.published ||
    requirement.relations.some((relation) =>
      !["implemented_by", "verified_by", "documents"].includes(relation.predicate)));
  if (unexpectedCutoverSemantics)
    candidateReasons.push("C2.5:unexpected_native_cutover_semantics");

  const retained = baseState.entries.map((entry) => entry.path)
    .filter((path) => !expectedOldPaths.includes(path)).sort((a, b) => a.localeCompare(b, "en"));
  const ownerEquivalentOnRetainedResources = candidateJ1.ok && retained.every((path) =>
    sameStrings([...(baseState.j1.owners[path] || [])].sort(), [...(candidateJ1.owners[path] || [])].sort()));
  if (!ownerEquivalentOnRetainedResources) candidateReasons.push("C2.5:owner_mismatch");
  const sharedOwnershipPaths = candidateJ1.ok
    ? Object.values(candidateJ1.owners).filter((owners) => owners.length > 1).length : 0;
  if (sharedOwnershipPaths !== 11) candidateReasons.push("C2.5:shared_ownership_mismatch");

  const requiredPermissions = migration.map((item) => item.permission).sort((a, b) => a.localeCompare(b, "en"));
  let trustAuthorized = false;
  const receipt = input.trustedRootReceipt;
  if (!receipt) {
    trustReasons.push("C2.5:trust_receipt_missing");
  } else {
    const keys = Object.keys(receipt).sort();
    const expectedKeys = ["authorityBaseRevision", "baseRevision", "headRevision", "permissions", "repository"].sort();
    if (!sameStrings(keys, expectedKeys)) trustReasons.push("C2.5:trust_receipt_invalid");
    if (receipt.repository !== input.repository) trustReasons.push("C2.5:trust_repository_mismatch");
    if (receipt.authorityBaseRevision !== input.trustedAuthorityBaseRevision)
      trustReasons.push("C2.5:trust_authority_base_mismatch");
    if (receipt.baseRevision !== input.baseRevision) trustReasons.push("C2.5:trust_base_mismatch");
    if (receipt.headRevision !== input.headRevision) trustReasons.push("C2.5:trust_head_mismatch");
    if (!Array.isArray(receipt.permissions) ||
        receipt.permissions.some((permission) => typeof permission !== "string" || !permission || permission.includes("*")) ||
        new Set(receipt.permissions).size !== receipt.permissions.length) {
      trustReasons.push("C2.5:trust_permissions_invalid");
    } else if (!sameStrings(
      [...receipt.permissions].sort((a, b) => a.localeCompare(b, "en")),
      requiredPermissions,
    )) {
      trustReasons.push("C2.5:trust_permissions_mismatch");
    }
    trustAuthorized = trustReasons.length === 0 && requiredPermissions.length === 8;
  }

  const authorizedRoots = trustAuthorized ? candidateRoots : [];
  const authorizedJ2 = evaluateRootedRequirements({
    requirements: lowered.requirements,
    trustedRoots: authorizedRoots,
  });
  let authorizedJ1 = emptyJ1;
  if (native.ok && authorizedJ2.ok) {
    const headPaths = new Set(headEntries.map((entry) => entry.path));
    const resolver = createResourceResolver({
      repository: input.repository,
      revision: input.headRevision,
      requirements: lowered.requirements,
      readers: {
        [input.repository]: (revision, path) =>
          revision === input.headRevision && headPaths.has(path)
            ? readFileAtRef(revision, path, input.repositoryRoot) : null,
      },
    });
    authorizedJ1 = evaluateTrackedResourceClosure({
      repository: input.repository,
      revision: input.headRevision,
      requirements: lowered.requirements,
      j2: authorizedJ2,
      trackedPaths: headEntries.map((entry) => entry.path),
      resourceRelations: lowered.resourceRelations,
      resolver,
    });
  }

  const normalizedCandidateReasons = uniqueSorted(candidateReasons);
  const normalizedTrustReasons = uniqueSorted(trustReasons);
  const reasons = uniqueSorted([...normalizedCandidateReasons, ...normalizedTrustReasons]);
  const candidateReady = normalizedCandidateReasons.length === 0;
  return {
    ok: candidateReady && trustAuthorized && authorizedJ2.ok && authorizedJ1.ok,
    candidateReady,
    reasons,
    trust: {
      authorized: trustAuthorized,
      repository: input.repository,
      authorityBaseRevision: input.trustedAuthorityBaseRevision,
      baseRevision: input.baseRevision,
      headRevision: input.headRevision,
    },
    blockingCutoverEligible: false,
    requiredPermissions,
    migration,
    candidate: {
      j2: { rooted: candidateJ2.rooted.length, unrooted: candidateJ2.unrooted.length },
      j1: {
        tracked: headEntries.length,
        justified: candidateJ1.justified.length,
        unjustified: candidateJ1.unjustified.length,
      },
    },
    authorized: {
      j2: { rooted: authorizedJ2.rooted.length, unrooted: authorizedJ2.unrooted.length },
      j1: {
        tracked: headEntries.length,
        justified: authorizedJ1.justified.length,
        unjustified: authorizedJ1.unjustified.length,
      },
    },
    equivalence: {
      normativeExact,
      normativeDigestExact,
      ownerEquivalentOnRetainedResources,
      rootIdentityChanges,
      sharedOwnershipPaths,
      relationCounts,
      blanketRequiresProjected,
    },
    rollback: {
      exactBaseRevision: input.baseRevision,
      legacyRootSubjects: oldRoots,
      legacySourcePaths: expectedOldPaths,
      legacyBlockingPathRetainedAtBase: true,
    },

  };
}

export interface RepoGuardNativeRollbackSnapshotInput {
  repository: string;
  repositoryRoot: string;
  trustedAuthorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  trustedRootReceipt?: RepoGuardTrustedRootMigrationReceipt | null;
}

function firstParentLegacyRollbackTarget(repositoryRoot: string, nativeBaseRevision: string): string | null {
  const history = runGit(["rev-list", "--first-parent", nativeBaseRevision], { cwd: repositoryRoot })
    .split("\n").filter(Boolean);
  for (const revision of history.slice(1)) {
    if (classifyRepoGuardSelfHostRepresentation(repositoryRoot, revision).kind === "legacy") return revision;
  }
  return null;
}

export function evaluateRepoGuardNativeRollbackSnapshot(input: RepoGuardNativeRollbackSnapshotInput) {
  const candidateReasons: string[] = [];
  const trustReasons: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    candidateReasons.push("A1:rollback_invalid_repository");
  for (const [label, revision] of [
    ["authority", input.trustedAuthorityBaseRevision],
    ["base", input.baseRevision],
    ["head", input.headRevision],
  ] as const) if (!exactSha.test(revision)) candidateReasons.push("A1:rollback_invalid_" + label + "_revision");

  if (input.trustedAuthorityBaseRevision !== input.baseRevision)
    candidateReasons.push("A1:rollback_authority_base_must_equal_native_base");
  if (classifyRepoGuardSelfHostRepresentation(input.repositoryRoot, input.baseRevision).kind !== "native")
    candidateReasons.push("A1:rollback_base_not_native");
  if (classifyRepoGuardSelfHostRepresentation(input.repositoryRoot, input.headRevision).kind !== "legacy")
    candidateReasons.push("A1:rollback_head_not_legacy");

  try {
    const mergeBase = runGit(["merge-base", input.baseRevision, input.headRevision], { cwd: input.repositoryRoot }).trim();
    if (mergeBase !== input.baseRevision) candidateReasons.push("A1:rollback_base_not_ancestor");
  } catch {
    candidateReasons.push("A1:rollback_base_not_ancestor");
  }

  let targetRevision: string | null = null;
  let exactLegacyTreeRestored = false;
  let forwardProof: ReturnType<typeof evaluateRepoGuardTrustedRootMigrationSnapshot> | null = null;
  try {
    targetRevision = firstParentLegacyRollbackTarget(input.repositoryRoot, input.baseRevision);
    if (!targetRevision) {
      candidateReasons.push("A1:rollback_legacy_target_missing");
    } else {
      const targetTree = runGit(["rev-parse", targetRevision + "^{tree}"], { cwd: input.repositoryRoot }).trim();
      const headTree = runGit(["rev-parse", input.headRevision + "^{tree}"], { cwd: input.repositoryRoot }).trim();
      exactLegacyTreeRestored = targetTree === headTree;
      if (!exactLegacyTreeRestored) candidateReasons.push("A1:rollback_tree_not_exact");
      forwardProof = evaluateRepoGuardTrustedRootMigrationSnapshot({
        repository: input.repository,
        repositoryRoot: input.repositoryRoot,
        trustedAuthorityBaseRevision: targetRevision,
        baseRevision: targetRevision,
        headRevision: input.baseRevision,
        trustedRootReceipt: null,
      });
      if (!forwardProof.candidateReady) candidateReasons.push("A1:rollback_forward_provenance_invalid");
    }
  } catch (error) {
    candidateReasons.push("A1:rollback_target_evaluation_failed:" + (error as Error).message);
  }

  const requiredPermissions = (forwardProof?.migration || []).map((item) =>
    "trusted_root:" + item.requirementId + ":" + item.newTrustedSubject.digest + ":" + item.oldTrustedSubject.digest)
    .sort((a, b) => a.localeCompare(b, "en"));

  let trustAuthorized = false;
  const receipt = input.trustedRootReceipt;
  if (!receipt) {
    trustReasons.push("A1:rollback_trust_receipt_missing");
  } else {
    const keys = Object.keys(receipt).sort();
    const expectedKeys = ["authorityBaseRevision", "baseRevision", "headRevision", "permissions", "repository"].sort();
    if (!sameStrings(keys, expectedKeys)) trustReasons.push("A1:rollback_trust_receipt_invalid");
    if (receipt.repository !== input.repository) trustReasons.push("A1:rollback_trust_repository_mismatch");
    if (receipt.authorityBaseRevision !== input.trustedAuthorityBaseRevision)
      trustReasons.push("A1:rollback_trust_authority_base_mismatch");
    if (receipt.baseRevision !== input.baseRevision) trustReasons.push("A1:rollback_trust_base_mismatch");
    if (receipt.headRevision !== input.headRevision) trustReasons.push("A1:rollback_trust_head_mismatch");
    if (!Array.isArray(receipt.permissions) ||
        receipt.permissions.some((permission) => typeof permission !== "string" || !permission || permission.includes("*")) ||
        new Set(receipt.permissions).size !== receipt.permissions.length) {
      trustReasons.push("A1:rollback_trust_permissions_invalid");
    } else if (!sameStrings([...receipt.permissions].sort((a, b) => a.localeCompare(b, "en")), requiredPermissions)) {
      trustReasons.push("A1:rollback_trust_permissions_mismatch");
    }
    trustAuthorized = trustReasons.length === 0 && requiredPermissions.length === 8;
  }

  const normalizedCandidateReasons = uniqueSorted(candidateReasons);
  const normalizedTrustReasons = uniqueSorted(trustReasons);
  const candidateReady = normalizedCandidateReasons.length === 0;
  return {
    ok: candidateReady && trustAuthorized,
    candidateReady,
    reasons: uniqueSorted([...normalizedCandidateReasons, ...normalizedTrustReasons]),
    trust: {
      authorized: trustAuthorized,
      authorityBaseRevision: input.trustedAuthorityBaseRevision,
      baseRevision: input.baseRevision,
      headRevision: input.headRevision,
    },
    requiredPermissions,
    exactLegacyTreeRestored,
    rollbackTargetRevision: targetRevision,
    forwardProvenanceCandidateReady: forwardProof?.candidateReady === true,
  };
}

const diffIdentity = (files: readonly ParsedDiffFile[]): string[] => files.map((file) =>
  JSON.stringify([file.status, file.gitStatus || "", file.previousPath || "", file.path])).sort();
const resourceDeltaIdentity = (files: readonly ParsedDiffFile[]): string[] => resourceDeltasFromParsedDiff(files)
  .map((delta) => JSON.stringify([delta.kind, delta.previousPath || "", delta.path, delta.beforeType || "", delta.afterType || ""])).sort();

function exactTreeChanges(baseEntries: ReturnType<typeof listTrackedEntriesAtRef>, headEntries: ReturnType<typeof listTrackedEntriesAtRef>) {
  const base = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const head = new Map(headEntries.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const path of uniqueSorted([...base.keys(), ...head.keys()])) {
    const before = base.get(path), after = head.get(path);
    if (before && after && before.mode === after.mode && before.type === after.type && before.object === after.object) continue;
    changes.push({
      path, beforeMode: before?.mode || null, afterMode: after?.mode || null,
      beforeType: before?.type || null, afterType: after?.type || null,
      modeChanged: !!before && !!after && before.mode !== after.mode,
      typeChanged: !!before && !!after && before.type !== after.type,
      objectChanged: before?.object !== after?.object,
    });
  }
  return changes;
}

export function evaluateRepoGuardSelfHost(input: RepoGuardSelfHostInput) {
  const reasons: string[] = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) reasons.push("I8:invalid_repository");
  for (const [label, revision] of [["authority", input.trustedAuthorityBaseRevision], ["base", input.baseRevision], ["head", input.headRevision]] as const)
    if (!exactSha.test(revision)) reasons.push(`I8:invalid_${label}_revision`);

  const authorityLoaded = loadRepoGuardProjection(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot);
  const acceptedSourcePaths = Object.fromEntries(authorityLoaded.raw.requirements.map((item) => [item.id, item.source.path]));
  const rootIds = authorityLoaded.rootIds;
  const authorityIds = Object.keys(authorityLoaded.requirements.index).sort();
  if (!sameStrings(rootIds, authorityIds)) reasons.push("I8:accepted_root_set_mismatch");
  const trustedRoots = rootIds.flatMap((id) => authorityLoaded.rootSubjects[id] ? [authorityLoaded.rootSubjects[id]!] : []);
  if (trustedRoots.length !== rootIds.length) reasons.push("I8:accepted_root_identity_missing");

  const authority = closeRepoGuardProjection(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot, authorityLoaded, trustedRoots);
  const baseLoaded = input.baseRevision === input.trustedAuthorityBaseRevision ? authorityLoaded :
    loadRepoGuardProjection(input.repository, input.baseRevision, input.repositoryRoot, acceptedSourcePaths);
  const headLoaded = input.headRevision === input.trustedAuthorityBaseRevision ? authorityLoaded :
    input.headRevision === input.baseRevision ? baseLoaded :
    loadRepoGuardProjection(input.repository, input.headRevision, input.repositoryRoot, acceptedSourcePaths);
  const base = input.baseRevision === authority.revision ? authority :
    closeRepoGuardProjection(input.repository, input.baseRevision, input.repositoryRoot, baseLoaded, trustedRoots);
  const exactPermission = (permission: string): boolean => (input.trustedReceipts || []).some((receipt) =>
    receipt.authorityBaseRevision === input.trustedAuthorityBaseRevision &&
    receipt.baseRevision === input.baseRevision &&
    receipt.headRevision === input.headRevision &&
    Array.isArray(receipt.permissions) &&
    receipt.permissions.every((item) => typeof item === "string" && item.length > 0 && item !== "*") &&
    receipt.permissions.includes(permission));
  const subjectKey = (subject: SemanticRequirementSubject): string =>
    [subject.repository, subject.requirementId, subject.digest].join("\0");
  const headTrustedRoots = rootIds.flatMap((id) => {
    const accepted = authorityLoaded.rootSubjects[id];
    const proposed = headLoaded.rootSubjects[id];
    if (!accepted) return [];
    if (proposed && subjectKey(proposed) !== subjectKey(accepted) && exactPermission("requirement:" + id)) return [proposed];
    return [accepted];
  });
  const head = input.headRevision === authority.revision ? authority :
    input.headRevision === base.revision ? base :
    closeRepoGuardProjection(input.repository, input.headRevision, input.repositoryRoot, headLoaded, headTrustedRoots);

  for (const [label, loaded, state] of [["authority", authorityLoaded, authority], ["base", baseLoaded, base], ["head", headLoaded, head]] as const) {
    if (loaded.errors.length) reasons.push(`I8:${label}_projection_invalid`);
    if (!state.j2.ok) reasons.push(`I8:${label}_j2_not_rooted`);
    if (!state.j1.ok) reasons.push(`I8:${label}_j1_not_closed`);
  }

  const exactTracked = head.entries.map((entry) => entry.path).sort();
  const observedTracked = [...input.observedTrackedPaths].sort();
  if (new Set(input.observedTrackedPaths).size !== input.observedTrackedPaths.length || !sameStrings(observedTracked, exactTracked))
    reasons.push("I8:tracked_tree_observation_mismatch");

  const exactDiff = getExactDiffIdentity(input.baseRevision, input.headRevision, input.repositoryRoot);
  if (!sameStrings(diffIdentity(input.observedDiffFiles), diffIdentity(exactDiff)))
    reasons.push("I8:git_diff_observation_mismatch");
  if (!sameStrings(resourceDeltaIdentity(input.observedDiffFiles), resourceDeltaIdentity(exactDiff)))
    reasons.push("I8:resource_delta_observation_mismatch");

  const treeChanges = exactTreeChanges(base.entries, head.entries);
  const treeEndpoints = uniqueSorted(treeChanges.map((change) => change.path));
  const diffEndpoints = uniqueSorted(exactDiff.flatMap((file) => file.previousPath ? [file.previousPath, file.path] : [file.path]));
  if (!sameStrings(treeEndpoints, diffEndpoints)) reasons.push("I8:git_tree_delta_mismatch");

  const transition = evaluateTransitionCauseClosure({
    repository: input.repository,
    base: { revision: base.revision, requirements: base.requirements, j2: base.j2, j1: base.j1 },
    head: { revision: head.revision, requirements: head.requirements, j2: head.j2, j1: head.j1 },
    trustedAuthorityBase: { revision: authority.revision, requirements: authority.requirements, j2: authority.j2 },
    resourceDeltas: resourceDeltasFromParsedDiff(input.observedDiffFiles),
    workIntent: input.workIntent || null,
    trustedReceipts: input.trustedReceipts || [],
    protectedResources: uniqueSorted([...selfHostProtectedResources, ...(input.protectedResources || [])]),
    evidenceFacts: input.evidenceFacts || [],
    observationFacts: input.observationFacts || [],
    trustedEvidenceProviders: input.trustedEvidenceProviders || [],
    authenticatedProviderGrants: input.authenticatedProviderGrants,
  });
  reasons.push(...transition.reasons.map((reason) => "I8:" + reason));
  const normalizedReasons = uniqueSorted(reasons);
  return {
    ok: normalizedReasons.length === 0, reasons: normalizedReasons,
    authority: {
      revision: authority.revision, rootSource: selfHostRootSource, rootIds,
      trustedRoots, rooted: authority.j2.rooted, tracked: authority.entries.length, justified: authority.j1.justified.length,
    },
    base: { revision: base.revision, rooted: base.j2.rooted, unrooted: base.j2.unrooted, tracked: base.entries.length, justified: base.j1.justified.length, unjustified: base.j1.unjustified },
    head: { revision: head.revision, rooted: head.j2.rooted, unrooted: head.j2.unrooted, tracked: head.entries.length, justified: head.j1.justified.length, unjustified: head.j1.unjustified },
    projection: {
      semanticDigestMatchesValue: headLoaded.requirements.requirements.every((item) =>
        item.semantic.digest === canonicalSemanticDigest(item.value)),
      normativeAuthoritySeparated: rootIds.every((id) =>
        !!headLoaded.rootSubjects[id] && headLoaded.rootSubjects[id]!.requirementId === id),
      sourceSemanticDigests: Object.fromEntries(headLoaded.raw.requirements.map((item) => [item.id, item.semantic.digest])),
      projectedSemanticDigests: Object.fromEntries(headLoaded.requirements.requirements.map((item) => [item.id, item.semantic.digest])),
      normativeAuthorityDigests: Object.fromEntries(rootIds.map((id) => [id, headLoaded.rootSubjects[id]?.digest || null])),
      facts: head.projectionFacts,
    },
    observation: {
      trackedComplete: sameStrings(observedTracked, exactTracked),
      exactTrackedCount: exactTracked.length,
      exactDiffIdentity: diffIdentity(exactDiff),
      observedDiffIdentity: diffIdentity(input.observedDiffFiles),
      treeChanges,
    },
    trustBoundary: {
      trustedAuthorityBaseRevision: input.trustedAuthorityBaseRevision,
      rootIdentitySource: "exact RG normative section subjects from accepted product requirements; relation representation identity is separate",
      providerAuthentication: "external to pure evaluator",
      protectedResources: uniqueSorted([...selfHostProtectedResources, ...(input.protectedResources || [])]),
      trustedEvidenceProviders: uniqueSorted(input.trustedEvidenceProviders || []),
      providerCapabilityMode: input.authenticatedProviderGrants !== undefined,
      authenticatedProviderGrantCount: input.authenticatedProviderGrants?.length || 0,
    },
    transition,
  };
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function evaluatePolicyPipeline(input: PolicyPipelineInput, options: PolicyPipelineOptions, reporter: AnalysisCollector) {
  const quiet = options.quiet || false, origin = options.policyOrigin || "shared", evidence = { policyOrigin: origin, enforcementMode: input.enforcement.mode };
  if (!quiet && options.printEnforcement !== false) console.log(renderEnforcementMode(input.enforcement));
  const report = (name: string, check: unknown) => reporter.report(`${options.ruleNamePrefix || ""}${name}`, check, evidence);
  for (const initialCheck of input.initialChecks || []) report(initialCheck.name, initialCheck.check);
  if (options.executionPhase !== "state") {
    const errors = compileChangeProfiles(input.policy as Parameters<typeof compileChangeProfiles>[0], object(input.changeIntent).change_type ?? null);
    if (errors.length) report("change-profile-selection", { ok: false, message: "change profile selection compilation failed", details: errors.map((error) => error.message) });
  }
  const { changeIntent = null, changeIntentSource = "none", ...runtimeInput } = input;
  const facts = buildPolicyFacts({ ...runtimeInput, changeIntent, changeIntentSource });
  if (!quiet) console.log(`\n${renderDiffAnalysis(facts)}`);
  const obligationPlan = buildStateObligationPlan(facts), replacedStateConstraintKeys = obligationPlan?.replaced_base_state_constraints.map((item) => item.key) || [];
  const satisfiedTransactionConstraintKeys = [...new Set(options.satisfiedTransactionConstraintKeys || [])];
  if (!quiet && replacedStateConstraintKeys.length) console.log(`State obligation plan: replaced ${replacedStateConstraintKeys.length} exact BASE state constraint(s): ${replacedStateConstraintKeys.join(", ")}`);
  const anchorDiagnostics = buildAnchorDiagnostics(facts);
  runPolicyChecks(facts, { report }, { anchorDiagnostics, excludeFamilies: options.excludeRuleFamilies, executionPhase: options.executionPhase, replacedStateConstraintKeys, satisfiedTransactionConstraintKeys });
  options.shadowObservation?.(facts);
  return {
    command: input.mode,
    repositoryRoot: facts.repositoryRoot,
    diff: { changedFiles: facts.diff.files.all.length, checkedFiles: facts.diff.files.checked.length, skippedOperationalFiles: facts.diagnostics.skippedOperationalFiles },
    ...(facts.repositoryObservation ? { repositoryObservation: facts.repositoryObservation } : {}),
    ...(obligationPlan ? { obligationPlan } : {}),
    ...(options.executionPhase ? { executionPhase: options.executionPhase } : {}),
    ...(satisfiedTransactionConstraintKeys.length ? { satisfiedTransactionConstraintKeys } : {}),
    ...anchorDiagnostics,
  };
}

export function runPolicyPipeline(input: PolicyPipelineInput, options: PolicyPipelineOptions = {}) {
  const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
  return reporter.finish(evaluatePolicyPipeline(input, options, reporter));
}

/**
 * I0-only non-authoritative shadow seam. Both evaluations receive the same
 * normalized observation, produced once by the existing pipeline.
 * The legacy report is completed before invoking candidate code.
 * No CLI, policy or production enforcement path calls this by default.
 */
export function runPolicyPipelineShadow(
  input: PolicyPipelineInput,
  options: Omit<PolicyPipelineOptions, "shadowObservation">,
  candidate: (facts: ReturnType<typeof buildPolicyFacts>) => { ok: boolean; reasons?: readonly string[] },
  expectedIntentionalDifference = false,
) {
  let observed: ReturnType<typeof buildPolicyFacts> | undefined;
  const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
  const metadata = evaluatePolicyPipeline(input, { ...options, shadowObservation: (facts) => { observed = facts; } }, reporter);
  const legacy = reporter.finish(metadata);
  if (!observed) throw new Error("I0: exact normalized observation was not captured");
  const legacyVerdict = { ok: legacy.ok, blocking: legacy.exitCode !== 0 };
  let candidateVerdict: { ok: boolean; reasons: string[] };
  try {
    const result = candidate(observed);
    if (typeof result?.ok !== "boolean") throw new Error("shadow candidate omitted boolean verdict");
    candidateVerdict = { ok: result.ok, reasons: [...new Set(result.reasons || [])].sort() };
  } catch (error) {
    candidateVerdict = { ok: false, reasons: ["SHADOW_EXECUTION_ERROR:" + (error instanceof Error ? error.message : String(error))] };
  }
  const identical = legacyVerdict.ok === candidateVerdict.ok;
  const classification = identical
    ? "EQUIVALENT"
    : expectedIntentionalDifference
      ? "EXPECTED_INTENTIONAL_DIFFERENCE"
      : "UNEXPECTED_DIFFERENCE";
  return {
    legacy,
    comparison: {
      legacy: legacyVerdict,
      candidate: candidateVerdict,
      identical,
      classification,
    },
  };
}

export function runRepoGuardSelfHostShadow(
  input: PolicyPipelineInput,
  options: Omit<PolicyPipelineOptions, "shadowObservation">,
  config: RepoGuardSelfHostConfig,
  expectedIntentionalDifference = false,
) {
  let selfHost: ReturnType<typeof evaluateRepoGuardSelfHost> | undefined;
  const shadow = runPolicyPipelineShadow(input, options, (facts) => {
    selfHost = evaluateRepoGuardSelfHost({
      ...config,
      observedTrackedPaths: facts.trackedFiles,
      observedDiffFiles: facts.diff.files.all,
    });
    return { ok: selfHost.ok, reasons: selfHost.reasons };
  }, expectedIntentionalDifference);
  return { ...shadow, selfHost: selfHost ?? null };
}


export interface RepositoryShadowReplayModelState {
  requirements: CanonicalRequirementsResult;
  rootSubjects?: Readonly<Record<string, SemanticRequirementSubject>>;
  resourceRelations?: readonly { from: string; kind: "generates"; to: string }[];
}
export interface RepositoryShadowReplayModel {
  authority: RepositoryShadowReplayModelState & { evaluationRoots: readonly SemanticRequirementSubject[] };
  base: RepositoryShadowReplayModelState;
  head: RepositoryShadowReplayModelState;
}
export interface RepositoryShadowReplayInput {
  repository: string;
  repositoryRoot: string;
  trustedAuthorityBaseRevision: string;
  baseRevision: string;
  headRevision: string;
  model?: RepositoryShadowReplayModel | null;
  workIntent?: WorkIntentFact | null;
  trustedReceipts?: readonly TransitionReceipt[];
  protectedResources?: readonly string[];
  evidenceFacts?: readonly TransitionEvidenceFact[];
  observationFacts?: readonly TransitionObservationFact[];
  trustedEvidenceProviders?: readonly string[];
  authenticatedProviderGrants?: readonly AuthenticatedProviderGrant[];
}

/**
 * I9 generic external-repository replay seam.
 *
 * It independently observes exact Git state and, when supplied, evaluates a
 * provisional migration model through the production J2/J1/J3/I7 machinery.
 * It deliberately cannot certify consumer authority: authentication remains
 * outside the pure evaluator. Therefore this function never returns
 * acceptedAuthorityVerified=true and cannot be used as a cutover gate.
 */
export function evaluateRepositoryShadowReplay(input: RepositoryShadowReplayInput) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error("I9 invalid repository identity");
  for (const [label, revision] of [
    ["authority", input.trustedAuthorityBaseRevision],
    ["base", input.baseRevision],
    ["head", input.headRevision],
  ] as const) if (!exactSha.test(revision)) throw new Error(`I9 invalid ${label} revision`);

  const authorityEntries = listTrackedEntriesAtRef(input.trustedAuthorityBaseRevision, input.repositoryRoot);
  const baseEntries = input.baseRevision === input.trustedAuthorityBaseRevision
    ? authorityEntries : listTrackedEntriesAtRef(input.baseRevision, input.repositoryRoot);
  const headEntries = input.headRevision === input.baseRevision
    ? baseEntries : input.headRevision === input.trustedAuthorityBaseRevision
      ? authorityEntries : listTrackedEntriesAtRef(input.headRevision, input.repositoryRoot);
  const exactDiff = getExactDiffIdentity(input.baseRevision, input.headRevision, input.repositoryRoot);
  const treeChanges = exactTreeChanges(baseEntries, headEntries);

  const observation = {
    repository: input.repository,
    authorityRevision: input.trustedAuthorityBaseRevision,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    authorityTracked: authorityEntries.length,
    baseTracked: baseEntries.length,
    headTracked: headEntries.length,
    exactDiffIdentity: diffIdentity(exactDiff),
    treeChanges,
    source: "existing production Git primitives",
  };

  if (!input.model) {
    return {
      observation,
      replay: {
        classification: "NOT_PROVEN" as const,
        ok: false,
        gaps: ["I9:no_accepted_or_provisional_vnext_model"],
        acceptedAuthorityVerified: false,
        readyForCutover: false,
        providerAuthentication: "external to pure evaluator",
      },
    };
  }

  const roots = input.model.authority.evaluationRoots;
  const close = (
    label: "authority" | "base" | "head",
    revision: string,
    entries: ReturnType<typeof listTrackedEntriesAtRef>,
    state: RepositoryShadowReplayModelState,
  ) => {
    const snapshotMismatch = state.requirements.requirements.some((requirement) =>
      requirement.representation.repository !== input.repository ||
      requirement.representation.revision !== revision);
    const j2 = evaluateRootedRequirements({
      requirements: state.requirements,
      trustedRoots: roots,
      rootSubjects: state.rootSubjects,
    });
    let j1 = {
      ok: false,
      justified: [] as string[],
      unjustified: entries.map((entry) => entry.path),
      errors: [{ code: "j2_not_rooted", path: "" }],
      explanations: {} as Record<string, string[]>,
      owners: {} as Record<string, string[]>,
    };
    if (!snapshotMismatch && state.requirements.ok && j2.ok) {
      const resolver = createResourceResolver({
        repository: input.repository,
        revision,
        requirements: state.requirements,
        readers: {
          [input.repository]: (sha, path) =>
            sha === revision ? readFileAtRef(sha, path, input.repositoryRoot) : null,
        },
      });
      j1 = evaluateTrackedResourceClosure({
        repository: input.repository,
        revision,
        requirements: state.requirements,
        j2,
        trackedPaths: entries.map((entry) => entry.path),
        resourceRelations: state.resourceRelations,
        resolver,
      });
    }
    return { label, revision, requirements: state.requirements, j2, j1, resourceRelations: state.resourceRelations, snapshotMismatch };
  };

  const authority = close("authority", input.trustedAuthorityBaseRevision, authorityEntries, input.model.authority);
  const base = close("base", input.baseRevision, baseEntries, input.model.base);
  const head = close("head", input.headRevision, headEntries, input.model.head);
  const transition = evaluateTransitionCauseClosure({
    repository: input.repository,
    trustedAuthorityBase: {
      revision: authority.revision,
      requirements: authority.requirements,
      j2: authority.j2,
      resourceRelations: authority.resourceRelations,
    },
    base: {
      revision: base.revision,
      requirements: base.requirements,
      j2: base.j2,
      j1: base.j1,
      resourceRelations: base.resourceRelations,
    },
    head: {
      revision: head.revision,
      requirements: head.requirements,
      j2: head.j2,
      j1: head.j1,
      resourceRelations: head.resourceRelations,
    },
    resourceDeltas: resourceDeltasFromParsedDiff(exactDiff),
    workIntent: input.workIntent || null,
    trustedReceipts: input.trustedReceipts || [],
    protectedResources: input.protectedResources || [],
    evidenceFacts: input.evidenceFacts || [],
    observationFacts: input.observationFacts || [],
    trustedEvidenceProviders: input.trustedEvidenceProviders || [],
    authenticatedProviderGrants: input.authenticatedProviderGrants,
  });
  const gaps = uniqueSorted([
    ...(authority.snapshotMismatch ? ["I9:authority_snapshot_mismatch"] : []),
    ...(base.snapshotMismatch ? ["I9:base_snapshot_mismatch"] : []),
    ...(head.snapshotMismatch ? ["I9:head_snapshot_mismatch"] : []),
    ...(!authority.j2.ok ? ["I9:authority_j2_not_rooted"] : []),
    ...(!base.j2.ok ? ["I9:base_j2_not_rooted"] : []),
    ...(!head.j2.ok ? ["I9:head_j2_not_rooted"] : []),
    ...(!authority.j1.ok ? ["I9:authority_j1_not_closed"] : []),
    ...(!base.j1.ok ? ["I9:base_j1_not_closed"] : []),
    ...(!head.j1.ok ? ["I9:head_j1_not_closed"] : []),
    ...transition.reasons.map((reason) => "I9:" + reason),
  ]);

  return {
    observation,
    replay: {
      classification: "PROVISIONAL_MIGRATION_MODEL" as const,
      ok: gaps.length === 0,
      gaps,
      acceptedAuthorityVerified: false,
      readyForCutover: false,
      rootSemantics: "authority-snapshot evaluation roots; never roots created by HEAD",
      providerAuthentication: "external to pure evaluator",
      authority: { revision: authority.revision, j2: authority.j2, j1: authority.j1 },
      base: { revision: base.revision, j2: base.j2, j1: base.j1 },
      head: { revision: head.revision, j2: head.j2, j1: head.j1 },
      transition,
    },
  };
}
