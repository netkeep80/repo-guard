import { normalizeDocumentFact } from "../document-facts.mjs";
import { getExactDiffIdentity, listTrackedEntriesAtRef, readFileAtRef } from "../git.mjs";
import { canonicalSemanticDigest, loadCanonicalRequirements, semanticRequirementSubject } from "./canonical-requirements.mjs";
import { evaluateRootedRequirements } from "./requirement-closure.mjs";
import { createResourceResolver } from "./resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "./resource-closure.mjs";
import { evaluateTransitionCauseClosure, resourceDeltasFromParsedDiff } from "./transition-closure.mjs";
import { buildPolicyFacts } from "../facts/input.mjs";
import { runPolicyChecks } from "../checks/orchestrator.mjs";
import { buildStateObligationPlan } from "../checks/state-obligation-plan.mjs";
import { compileChangeProfiles } from "../policy-compiler.mjs";
import { buildAnchorDiagnostics } from "../reporting/anchor-diagnostics.mjs";
import { createAnalysisCollector } from "./analysis-report.mjs";
import { createAnalysisTextPresenter, renderDiffAnalysis, renderEnforcementMode } from "../reporting/renderers.mjs";
const selfHostRootSource = "docs/product-requirements.md";
const selfHostProtectedResources = Object.freeze([selfHostRootSource, ".github/workflows/trusted-enforcement.yml"]);
const legacyPredicates = Object.freeze({
    requires: "requires", implements: "implemented_by", verifies: "verified_by", documents: "documents",
});
const exactSha = /^[0-9a-f]{40}$/;
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
const exactResourcePath = (value) => {
    if (typeof value !== "string")
        throw new Error("resource path must be a string");
    const normalized = normalizeDocumentFact(value, "repository_path");
    if (normalized !== value || /[*?\[\]{}]/.test(value) || value.endsWith("/"))
        throw new Error("noncanonical or wildcard resource path");
    return value;
};
const sameStrings = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
export function projectRepoGuardLegacyRequirements(raw, implicitSourcePaths = Object.fromEntries(raw.requirements.map((item) => [item.id, item.source.path])), authoritySubjects = Object.fromEntries(raw.requirements.map((item) => [item.id, item.semantic]))) {
    const projectionErrors = [];
    const facts = [];
    const projected = [];
    for (const item of raw.requirements) {
        const root = object(item.value);
        const artifacts = root.artifacts;
        const allowedRoot = Object.keys(root).every((key) => key === "id" || key === "artifacts");
        if (!allowedRoot || root.id !== item.id || !Array.isArray(artifacts)) {
            projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: "I8 legacy projection requires exact id + artifacts shape" });
            continue;
        }
        const relations = {};
        const seen = new Set();
        for (let artifactIndex = 0; artifactIndex < artifacts.length; artifactIndex++) {
            const artifact = object(artifacts[artifactIndex]);
            if (Object.keys(artifact).sort().join(",") !== "path,relations" || !Array.isArray(artifact.relations)) {
                projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 invalid legacy artifact entry ${artifactIndex}` });
                continue;
            }
            let path;
            try {
                path = exactResourcePath(artifact.path);
            }
            catch (error) {
                projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 artifact ${artifactIndex}: ${error.message}` });
                continue;
            }
            for (let relationIndex = 0; relationIndex < artifact.relations.length; relationIndex++) {
                const legacy = artifact.relations[relationIndex];
                if (typeof legacy !== "string" || !Object.hasOwn(legacyPredicates, legacy)) {
                    projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 unsupported legacy predicate ${String(legacy)}` });
                    continue;
                }
                const predicate = legacyPredicates[legacy];
                const identity = JSON.stringify([predicate, path]);
                if (seen.has(identity)) {
                    projectionErrors.push({ code: "invalid_canonical_source", path: item.source.path, message: `I8 duplicate projected relation ${predicate}:${path}` });
                    continue;
                }
                seen.add(identity);
                const implicitSourcePath = implicitSourcePaths[item.id] || item.source.path;
                if (legacy === "requires" && path === implicitSourcePath)
                    continue;
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
        };
        projected.push({
            ...item,
            value,
            semantic: semanticRequirementSubject(item.semantic.repository, item.id, canonicalSemanticDigest(value)),
        });
    }
    const errors = [...raw.errors, ...projectionErrors].sort((a, b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en") || a.message.localeCompare(b.message, "en"));
    const requirements = projected.sort((a, b) => a.id.localeCompare(b.id, "en"));
    const index = Object.create(null);
    for (const item of requirements)
        index[item.id] = item;
    const result = {
        ok: raw.ok && projectionErrors.length === 0,
        requirements, index, errors,
        resolveFragment: raw.resolveFragment,
    };
    return { requirements: result, facts: facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), errors: projectionErrors };
}
function acceptedRootAuthority(repository, revision, repositoryRoot) {
    const raw = readFileAtRef(revision, selfHostRootSource, repositoryRoot);
    if (raw === null)
        throw new Error("I8 accepted root source missing");
    const sections = new Map();
    let current = null;
    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^###\s+(RG-[0-9]{2})\s+—/);
        if (match) {
            current = match[1];
            if (sections.has(current))
                throw new Error(`I8 accepted root source has duplicate ${current} heading`);
            sections.set(current, [line]);
            continue;
        }
        if (current && /^#{1,3}\s+/.test(line))
            current = null;
        if (current)
            sections.get(current).push(line);
    }
    const ids = [...sections.keys()].sort((a, b) => a.localeCompare(b, "en"));
    if (!ids.length)
        throw new Error("I8 accepted root source has no RG headings");
    const subjects = Object.create(null);
    for (const id of ids) {
        const value = { id, source: selfHostRootSource, text: sections.get(id).join("\n") };
        subjects[id] = semanticRequirementSubject(repository, id, canonicalSemanticDigest(value));
    }
    return { ids, subjects };
}
function loadRepoGuardProjection(repository, revision, repositoryRoot, implicitSourcePaths) {
    if (!exactSha.test(revision))
        throw new Error("I8 exact revision must be 40 lowercase hex");
    const entries = listTrackedEntriesAtRef(revision, repositoryRoot);
    const canonicalPaths = entries.map((entry) => entry.path)
        .filter((path) => path.startsWith("requirements/") && /\.(?:yaml|yml|json)$/.test(path));
    const raw = loadCanonicalRequirements({
        repository, revision, paths: canonicalPaths,
        readFile: (sha, path) => readFileAtRef(sha, path, repositoryRoot),
    });
    const rootAuthority = acceptedRootAuthority(repository, revision, repositoryRoot);
    const projection = projectRepoGuardLegacyRequirements(raw, implicitSourcePaths, rootAuthority.subjects);
    return { entries, raw, rootIds: rootAuthority.ids, rootSubjects: rootAuthority.subjects, ...projection };
}
function closeRepoGuardProjection(repository, revision, repositoryRoot, loaded, trustedRoots) {
    const j2 = evaluateRootedRequirements({ requirements: loaded.requirements, trustedRoots, rootSubjects: loaded.rootSubjects });
    let j1 = {
        ok: false, justified: [], unjustified: loaded.entries.map((entry) => entry.path),
        errors: [{ code: "j2_not_rooted", path: "" }], explanations: {},
        owners: {},
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
const diffIdentity = (files) => files.map((file) => JSON.stringify([file.status, file.gitStatus || "", file.previousPath || "", file.path])).sort();
const resourceDeltaIdentity = (files) => resourceDeltasFromParsedDiff(files)
    .map((delta) => JSON.stringify([delta.kind, delta.previousPath || "", delta.path, delta.beforeType || "", delta.afterType || ""])).sort();
function exactTreeChanges(baseEntries, headEntries) {
    const base = new Map(baseEntries.map((entry) => [entry.path, entry]));
    const head = new Map(headEntries.map((entry) => [entry.path, entry]));
    const changes = [];
    for (const path of uniqueSorted([...base.keys(), ...head.keys()])) {
        const before = base.get(path), after = head.get(path);
        if (before && after && before.mode === after.mode && before.type === after.type && before.object === after.object)
            continue;
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
export function evaluateRepoGuardSelfHost(input) {
    const reasons = [];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
        reasons.push("I8:invalid_repository");
    for (const [label, revision] of [["authority", input.trustedAuthorityBaseRevision], ["base", input.baseRevision], ["head", input.headRevision]])
        if (!exactSha.test(revision))
            reasons.push(`I8:invalid_${label}_revision`);
    const authorityLoaded = loadRepoGuardProjection(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot);
    const acceptedSourcePaths = Object.fromEntries(authorityLoaded.raw.requirements.map((item) => [item.id, item.source.path]));
    const rootIds = authorityLoaded.rootIds;
    const authorityIds = Object.keys(authorityLoaded.requirements.index).sort();
    if (!sameStrings(rootIds, authorityIds))
        reasons.push("I8:accepted_root_set_mismatch");
    const trustedRoots = rootIds.flatMap((id) => authorityLoaded.rootSubjects[id] ? [authorityLoaded.rootSubjects[id]] : []);
    if (trustedRoots.length !== rootIds.length)
        reasons.push("I8:accepted_root_identity_missing");
    const authority = closeRepoGuardProjection(input.repository, input.trustedAuthorityBaseRevision, input.repositoryRoot, authorityLoaded, trustedRoots);
    const baseLoaded = input.baseRevision === input.trustedAuthorityBaseRevision ? authorityLoaded :
        loadRepoGuardProjection(input.repository, input.baseRevision, input.repositoryRoot, acceptedSourcePaths);
    const headLoaded = input.headRevision === input.trustedAuthorityBaseRevision ? authorityLoaded :
        input.headRevision === input.baseRevision ? baseLoaded :
            loadRepoGuardProjection(input.repository, input.headRevision, input.repositoryRoot, acceptedSourcePaths);
    const base = input.baseRevision === authority.revision ? authority :
        closeRepoGuardProjection(input.repository, input.baseRevision, input.repositoryRoot, baseLoaded, trustedRoots);
    const exactPermission = (permission) => (input.trustedReceipts || []).some((receipt) => receipt.authorityBaseRevision === input.trustedAuthorityBaseRevision &&
        receipt.baseRevision === input.baseRevision &&
        receipt.headRevision === input.headRevision &&
        Array.isArray(receipt.permissions) &&
        receipt.permissions.every((item) => typeof item === "string" && item.length > 0 && item !== "*") &&
        receipt.permissions.includes(permission));
    const subjectKey = (subject) => [subject.repository, subject.requirementId, subject.digest].join("\0");
    const headTrustedRoots = rootIds.flatMap((id) => {
        const accepted = authorityLoaded.rootSubjects[id];
        const proposed = headLoaded.rootSubjects[id];
        if (!accepted)
            return [];
        if (proposed && subjectKey(proposed) !== subjectKey(accepted) && exactPermission("requirement:" + id))
            return [proposed];
        return [accepted];
    });
    const head = input.headRevision === authority.revision ? authority :
        input.headRevision === base.revision ? base :
            closeRepoGuardProjection(input.repository, input.headRevision, input.repositoryRoot, headLoaded, headTrustedRoots);
    for (const [label, loaded, state] of [["authority", authorityLoaded, authority], ["base", baseLoaded, base], ["head", headLoaded, head]]) {
        if (loaded.errors.length)
            reasons.push(`I8:${label}_projection_invalid`);
        if (!state.j2.ok)
            reasons.push(`I8:${label}_j2_not_rooted`);
        if (!state.j1.ok)
            reasons.push(`I8:${label}_j1_not_closed`);
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
    if (!sameStrings(treeEndpoints, diffEndpoints))
        reasons.push("I8:git_tree_delta_mismatch");
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
            semanticDigestMatchesValue: headLoaded.requirements.requirements.every((item) => item.semantic.digest === canonicalSemanticDigest(item.value)),
            normativeAuthoritySeparated: rootIds.every((id) => !!headLoaded.rootSubjects[id] && headLoaded.rootSubjects[id].requirementId === id),
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
        },
        transition,
    };
}
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export function evaluatePolicyPipeline(input, options, reporter) {
    const quiet = options.quiet || false, origin = options.policyOrigin || "shared", evidence = { policyOrigin: origin, enforcementMode: input.enforcement.mode };
    if (!quiet && options.printEnforcement !== false)
        console.log(renderEnforcementMode(input.enforcement));
    const report = (name, check) => reporter.report(`${options.ruleNamePrefix || ""}${name}`, check, evidence);
    for (const initialCheck of input.initialChecks || [])
        report(initialCheck.name, initialCheck.check);
    if (options.executionPhase !== "state") {
        const errors = compileChangeProfiles(input.policy, object(input.changeIntent).change_type ?? null);
        if (errors.length)
            report("change-profile-selection", { ok: false, message: "change profile selection compilation failed", details: errors.map((error) => error.message) });
    }
    const { changeIntent = null, changeIntentSource = "none", ...runtimeInput } = input;
    const facts = buildPolicyFacts({ ...runtimeInput, changeIntent, changeIntentSource });
    if (!quiet)
        console.log(`\n${renderDiffAnalysis(facts)}`);
    const obligationPlan = buildStateObligationPlan(facts), replacedStateConstraintKeys = obligationPlan?.replaced_base_state_constraints.map((item) => item.key) || [];
    const satisfiedTransactionConstraintKeys = [...new Set(options.satisfiedTransactionConstraintKeys || [])];
    if (!quiet && replacedStateConstraintKeys.length)
        console.log(`State obligation plan: replaced ${replacedStateConstraintKeys.length} exact BASE state constraint(s): ${replacedStateConstraintKeys.join(", ")}`);
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
export function runPolicyPipeline(input, options = {}) {
    const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
    return reporter.finish(evaluatePolicyPipeline(input, options, reporter));
}
/**
 * I0-only non-authoritative shadow seam. Both evaluations receive the same
 * normalized observation, produced once by the existing pipeline.
 * The legacy report is completed before invoking candidate code.
 * No CLI, policy or production enforcement path calls this by default.
 */
export function runPolicyPipelineShadow(input, options, candidate, expectedIntentionalDifference = false) {
    let observed;
    const reporter = createAnalysisCollector(input.enforcement, { presenter: options.quiet ? null : createAnalysisTextPresenter() });
    const metadata = evaluatePolicyPipeline(input, { ...options, shadowObservation: (facts) => { observed = facts; } }, reporter);
    const legacy = reporter.finish(metadata);
    if (!observed)
        throw new Error("I0: exact normalized observation was not captured");
    const legacyVerdict = { ok: legacy.ok, blocking: legacy.exitCode !== 0 };
    let candidateVerdict;
    try {
        const result = candidate(observed);
        if (typeof result?.ok !== "boolean")
            throw new Error("shadow candidate omitted boolean verdict");
        candidateVerdict = { ok: result.ok, reasons: [...new Set(result.reasons || [])].sort() };
    }
    catch (error) {
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
export function runRepoGuardSelfHostShadow(input, options, config, expectedIntentionalDifference = false) {
    let selfHost;
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


/**
 * I9 generic external-repository replay seam.
 *
 * It independently observes exact Git state and, when supplied, evaluates a
 * provisional migration model through the production J2/J1/J3/I7 machinery.
 * It deliberately cannot certify consumer authority: authentication remains
 * outside the pure evaluator. Therefore this function never returns
 * acceptedAuthorityVerified=true and cannot be used as a cutover gate.
 */
export function evaluateRepositoryShadowReplay(input) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
        throw new Error("I9 invalid repository identity");
    for (const [label, revision] of [
        ["authority", input.trustedAuthorityBaseRevision],
        ["base", input.baseRevision],
        ["head", input.headRevision],
    ])
        if (!exactSha.test(revision))
            throw new Error(`I9 invalid ${label} revision`);
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
                classification: "NOT_PROVEN",
                ok: false,
                gaps: ["I9:no_accepted_or_provisional_vnext_model"],
                acceptedAuthorityVerified: false,
                readyForCutover: false,
                providerAuthentication: "external to pure evaluator",
            },
        };
    }
    const roots = input.model.authority.evaluationRoots;
    const close = (label, revision, entries, state) => {
        const snapshotMismatch = state.requirements.requirements.some((requirement) => requirement.representation.repository !== input.repository ||
            requirement.representation.revision !== revision);
        const j2 = evaluateRootedRequirements({
            requirements: state.requirements,
            trustedRoots: roots,
            rootSubjects: state.rootSubjects,
        });
        let j1 = {
            ok: false,
            justified: [],
            unjustified: entries.map((entry) => entry.path),
            errors: [{ code: "j2_not_rooted", path: "" }],
            explanations: {},
            owners: {},
        };
        if (!snapshotMismatch && state.requirements.ok && j2.ok) {
            const resolver = createResourceResolver({
                repository: input.repository,
                revision,
                requirements: state.requirements,
                readers: {
                    [input.repository]: (sha, path) => sha === revision ? readFileAtRef(sha, path, input.repositoryRoot) : null,
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
            classification: "PROVISIONAL_MIGRATION_MODEL",
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
