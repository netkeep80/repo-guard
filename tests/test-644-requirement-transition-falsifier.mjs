import test from "node:test";
import assert from "node:assert/strict";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";
import {
  checkRequirementTransition,
  checkRoutineRequirementTransition,
  compareRequirementRelationGraphs,
  normalizeRequirementAuthority,
} from "../dist/requirement-relations.mjs";

function requirementsPolicy(overrides = {}) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: [],
      operational_paths: [],
    },
    diff_rules: {
      max_new_docs: 10,
      max_new_files: 10,
      max_net_added_lines: 1000,
    },
    content_rules: [],
    cochange_rules: [],
    packs: {
      "requirements-strict": {
        requirement_yaml_globs: ["requirements/*.yaml"],
        requirement_id_pattern: "RG-[A-Z0-9-]+",
        strict_heading_docs: ["docs/**/*.md"],
        ...overrides,
      },
    },
  };
}

function resolvePolicy(overrides = {}) {
  const resolved = resolvePolicyPacks(requirementsPolicy(overrides));
  assert.equal(resolved.ok, true, "falsifier fixture policy must resolve");
  return resolved.policy;
}

function run(policy, files, diffText, { initialChecks = [], options = {} } = {}) {
  return runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: "/tmp/repo-guard-644-falsifier",
    policy,
    changeIntent: null,
    changeIntentSource: "none",
    enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
    diffText,
    trackedFiles: Object.keys(files),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`missing fixture ${path}`);
      return files[path];
    },
    initialChecks,
  }, { quiet: true, ...options });
}

test("#644 RED: self-authored HEAD closure must not authorize its own new artifact relation", () => {
  const policy = resolvePolicy({
    closed_repository: true,
    evidence_surfaces: ["garbage.tmp"],
    changed_requirement_evidence_surfaces: ["garbage.tmp"],
  });
  const files = {
    "requirements/garbage.yaml": [
      "id: RG-GARBAGE-01",
      "artifacts:",
      "  - path: requirements/garbage.yaml",
      "    role: requirement",
      "  - path: garbage.tmp",
      "    role: implementation",
      "",
    ].join("\n"),
    "garbage.tmp": "candidate-owned garbage\n",
  };
  const diffText = [
    "diff --git a/requirements/garbage.yaml b/requirements/garbage.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/requirements/garbage.yaml",
    "+id: RG-GARBAGE-01",
    "+artifacts:",
    "+  - path: requirements/garbage.yaml",
    "+    role: requirement",
    "+  - path: garbage.tmp",
    "+    role: implementation",
    "diff --git a/garbage.tmp b/garbage.tmp",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/garbage.tmp",
    "+candidate-owned garbage",
  ].join("\n");

  const closureOnly = run(policy, files, diffText);
  assert.deepEqual(
    closureOnly.violations,
    [],
    "HEAD-only closure remains a state invariant and is internally self-consistent",
  );

  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: "a".repeat(40),
    sources: [],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{ path: "requirements/garbage.yaml", format: "yaml", content: files["requirements/garbage.yaml"] }],
  });
  const transition = checkRequirementTransition({
    base,
    head,
    trustedAuthorizer: { trusted: true, source: "repository_permission" },
  });
  assert.equal(transition.ok, false);
  assert.ok(transition.reasons.includes("requirement_transition_grant_missing"));

  const guarded = run(policy, files, diffText, {
    initialChecks: [{
      name: "requirement-transition",
      check: { ok: transition.ok, details: transition.reasons },
    }],
  });
  assert.equal(guarded.ok, false, "trusted transition boundary must turn the structurally self-consistent candidate RED");
  assert.ok(guarded.violations.some((item) => item.rule === "requirement-transition"));
});

test("#644 witness: relation-only requirement administration currently demands dummy evidence touch", () => {
  const policy = resolvePolicy({
    evidence_surfaces: ["src/**"],
    changed_requirement_evidence_surfaces: ["src/**"],
  });
  const files = {
    "requirements/ownership.yaml": [
      "id: RG-OWNERSHIP-01",
      "artifacts:",
      "  - path: src/runtime.mts",
      "    role: implementation",
      "",
    ].join("\n"),
    "src/runtime.mts": "export const runtime = true;\n",
  };
  const diffText = [
    "diff --git a/requirements/ownership.yaml b/requirements/ownership.yaml",
    "--- a/requirements/ownership.yaml",
    "+++ b/requirements/ownership.yaml",
    "-id: RG-OLD-OWNERSHIP",
    "+id: RG-OWNERSHIP-01",
  ].join("\n");

  const result = run(policy, files, diffText);
  const violation = result.violations.find(
    (item) => item.rule === "trace-rule: changed-requirements-need-evidence",
  );

  assert.ok(
    violation,
    "current accepted rule must expose the administrative-transition dummy-touch deadlock",
  );
  assert.deepEqual(
    violation.data?.operands?.right?.selector?.patterns,
    ["src/**"],
    "the rejection must be caused by missing changed evidence surface, not another fixture defect",
  );
  assert.equal(result.ok, false);

  const baseR1 = [
    "id: RG-OLD-OWNERSHIP",
    "artifacts:",
    "  - path: src/runtime.mts",
    "    role: implementation",
    "",
  ].join("\n");
  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: "a".repeat(40),
    sources: [{ path: "requirements/ownership.yaml", format: "yaml", content: baseR1 }],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{ path: "requirements/ownership.yaml", format: "yaml", content: files["requirements/ownership.yaml"] }],
  });
  const delta = compareRequirementRelationGraphs(base, head);
  const transition = checkRequirementTransition({
    base,
    head,
    grant: {
      base_authority_sha256: base.authority_sha256,
      expected_head_authority_sha256: head.authority_sha256,
      add: delta.add,
      remove: delta.remove,
    },
    trustedAuthorizer: { trusted: true, source: "repository_permission" },
  });
  assert.equal(transition.ok, true);

  const authorized = run(policy, files, diffText, {
    initialChecks: [{ name: "requirement-transition", check: { ok: true } }],
    options: { satisfiedTransactionConstraintKeys: ["trace:changed-requirements-need-evidence"] },
  });
  assert.equal(authorized.ok, true, "exact trusted authority transition must satisfy the administrative evidence obligation");
  assert.deepEqual(authorized.satisfiedTransactionConstraintKeys, ["trace:changed-requirements-need-evidence"]);
});


test("#700 witness: accepted routine path is additive-only and rejects replacement", () => {
  const baseRequirement = [
    "id: RG-REPLACE-01",
    "artifacts:",
    "  - path: src/old.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");
  const headRequirement = [
    "id: RG-REPLACE-01",
    "artifacts:",
    "  - path: src/new.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");

  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: "a".repeat(40),
    sources: [{ path: "requirements/replace.yaml", format: "yaml", content: baseRequirement }],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: "b".repeat(40),
    sources: [{ path: "requirements/replace.yaml", format: "yaml", content: headRequirement }],
  });

  const routine = checkRoutineRequirementTransition({
    base,
    head,
    changedFiles: [
      { path: "requirements/replace.yaml", addedLines: [], deletedLines: [], status: "modified" },
      { path: "src/old.mts", addedLines: [], deletedLines: [], status: "deleted" },
      { path: "src/new.mts", addedLines: [], deletedLines: [], status: "added" },
    ],
    headTrackedFiles: ["requirements/replace.yaml", "src/new.mts"],
    readFileAtRef: (revision, path) => {
      assert.equal(path, "requirements/replace.yaml");
      return revision === base.revision ? baseRequirement : headRequirement;
    },
    governancePaths: [],
    forbiddenPaths: [],
    closedRepository: true,
  });

  assert.equal(routine.ok, false);
  assert.ok(
    routine.reasons.includes("routine_requires_additive_relation_delta"),
    "accepted main must expose the exact additive-only blocker reproduced by #700 O1 RED",
  );
});


const J3_STATE_RELATIONS_700 = new Set([
  "requires",
  "implemented_by",
  "verified_by",
  "documents",
  "generates",
]);
const J3_REQUIREMENT_RELATIONS_700 = new Set([
  "derives_from",
  "depends_on",
  "constrains",
  "supersedes",
]);

function stable700(value) {
  if (Array.isArray(value)) return "[" + value.map(stable700).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable700(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function relationKey700(relation) {
  return [relation.from, relation.kind, relation.to].join("|");
}

function graph700({
  roots = [],
  requirements = [],
  resources = [],
  relations = [],
  lifecycle = {},
} = {}) {
  return {
    roots: [...roots],
    requirements: requirements.map((item) => ({ ...item })),
    resources: resources.map((item) => ({ tracked: true, ...item })),
    relations: relations.map((item) => ({ ...item })),
    lifecycle: structuredClone(lifecycle),
  };
}

const req700 = (id, extra = {}) => ({ id, semantic: id, normative: true, ...extra });
const res700 = (id, kind = "code", extra = {}) => ({ id, kind, tracked: true, locator: id, content: id, ...extra });
const rel700 = (from, kind, to) => ({ from, kind, to });
const wi700 = (addresses, extra = {}) => ({ id: "W", source: "pr", state: "open", addresses: [...addresses], ...extra });
const receipt700 = (baseSha, headSha, permissions) => ({ baseSha, headSha, permissions: [...permissions] });

function mapById700(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function j2Closure700(graph) {
  const requirements = mapById700(graph.requirements);
  const paths = new Map();
  for (const root of [...graph.roots].sort()) {
    if (requirements.has(root)) paths.set(root, [root]);
  }
  let changed = true;
  const relations = graph.relations.filter((r) => r.kind === "derives_from").sort((a, b) => relationKey700(a).localeCompare(relationKey700(b)));
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (!requirements.has(relation.from) || !paths.has(relation.to) || paths.has(relation.from)) continue;
      paths.set(relation.from, [...paths.get(relation.to), relation.from]);
      changed = true;
    }
  }
  const orphanRequirements = [...requirements.keys()].filter((id) => !paths.has(id)).sort();
  return { ok: orphanRequirements.length === 0, paths, orphanRequirements };
}

function j1Closure700(graph, j2 = j2Closure700(graph)) {
  const resources = mapById700(graph.resources);
  const reached = new Map();
  const queue = [];
  for (const [id, path] of [...j2.paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    reached.set(id, path);
    queue.push(id);
  }
  const relations = graph.relations
    .filter((r) => J3_STATE_RELATIONS_700.has(r.kind))
    .sort((a, b) => relationKey700(a).localeCompare(relationKey700(b)));
  const missingTargets = new Set();
  while (queue.length) {
    const node = queue.shift();
    for (const relation of relations) {
      if (relation.from !== node || reached.has(relation.to)) continue;
      if (!resources.has(relation.to)) {
        missingTargets.add(relation.to);
        continue;
      }
      reached.set(relation.to, [...reached.get(node), relation.to]);
      queue.push(relation.to);
    }
  }
  const orphanTrackedResources = graph.resources
    .filter((resource) => resource.tracked !== false && !reached.has(resource.id))
    .map((resource) => resource.id)
    .sort();
  return {
    ok: orphanTrackedResources.length === 0 && missingTargets.size === 0,
    paths: new Map([...reached.entries()].filter(([id]) => resources.has(id))),
    orphanTrackedResources,
    missingTargets: [...missingTargets].sort(),
  };
}

function validateHead700(graph) {
  const j2 = j2Closure700(graph);
  const j1 = j1Closure700(graph, j2);
  return {
    ok: j2.ok && j1.ok,
    j2,
    j1,
    reasons: [
      ...j2.orphanRequirements.map((id) => "J2:orphan_requirement:" + id),
      ...j1.orphanTrackedResources.map((id) => "J1:orphan_tracked_resource:" + id),
      ...j1.missingTargets.map((id) => "J1:missing_required_resource:" + id),
    ],
  };
}

function transitionDeltas700(base, head) {
  const deltas = [];
  const baseRequirements = mapById700(base.requirements);
  const headRequirements = mapById700(head.requirements);
  const requirementIds = [...new Set([...baseRequirements.keys(), ...headRequirements.keys()])].sort();
  for (const id of requirementIds) {
    const before = baseRequirements.get(id), after = headRequirements.get(id);
    if (!before) deltas.push({ kind: "requirement_add", subject: id });
    else if (!after) deltas.push({ kind: "requirement_delete", subject: id });
    else if (stable700(before) !== stable700(after)) deltas.push({ kind: "requirement_modify", subject: id });
  }

  const baseResources = mapById700(base.resources);
  const headResources = mapById700(head.resources);
  const resourceIds = [...new Set([...baseResources.keys(), ...headResources.keys()])].sort();
  for (const id of resourceIds) {
    const before = baseResources.get(id), after = headResources.get(id);
    if (!before) {
      deltas.push({ kind: "resource_add", subject: id });
      continue;
    }
    if (!after) {
      deltas.push({ kind: "resource_delete", subject: id });
      continue;
    }
    if (before.locator !== after.locator) deltas.push({ kind: "resource_rename", subject: id });
    if (before.type !== after.type) deltas.push({ kind: "resource_type_change", subject: id });
    if (before.kind === "external_dependency" && before.exact !== after.exact) {
      deltas.push({ kind: "dependency_update", subject: id });
    } else if (before.content !== after.content) {
      deltas.push({ kind: "resource_modify", subject: id });
    }
  }

  const baseRelations = new Map(base.relations.map((relation) => [relationKey700(relation), relation]));
  const headRelations = new Map(head.relations.map((relation) => [relationKey700(relation), relation]));
  for (const [key, relation] of [...baseRelations.entries()].sort()) {
    if (!headRelations.has(key)) deltas.push({ kind: "relation_remove", subject: key, relation });
  }
  for (const [key, relation] of [...headRelations.entries()].sort()) {
    if (!baseRelations.has(key)) deltas.push({ kind: "relation_add", subject: key, relation });
  }

  const lifecycleIds = [...new Set([...Object.keys(base.lifecycle), ...Object.keys(head.lifecycle)])].sort();
  for (const id of lifecycleIds) {
    const before = base.lifecycle[id] || {};
    const after = head.lifecycle[id] || {};
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const field of fields) {
      if (before[field] !== after[field]) {
        deltas.push({ kind: "lifecycle", subject: id, field, before: before[field], after: after[field] });
      }
    }
  }

  return deltas.sort((a, b) => {
    const ak = [a.kind, a.subject, a.field || ""].join("|");
    const bk = [b.kind, b.subject, b.field || ""].join("|");
    return ak.localeCompare(bk);
  });
}

function requirementImpactClosure700(graph, seedIds) {
  const requirements = mapById700(graph.requirements);
  const impacted = new Set([...seedIds].filter((id) => requirements.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of graph.relations) {
      if (relation.kind === "derives_from") {
        if (impacted.has(relation.from) && requirements.has(relation.to) && !impacted.has(relation.to)) {
          impacted.add(relation.to); changed = true;
        }
        if (impacted.has(relation.to) && requirements.has(relation.from) && !impacted.has(relation.from)) {
          impacted.add(relation.from); changed = true;
        }
      } else if ((relation.kind === "depends_on" || relation.kind === "constrains") && impacted.has(relation.to)
        && requirements.has(relation.from) && !impacted.has(relation.from)) {
        impacted.add(relation.from); changed = true;
      }
    }
  }
  return impacted;
}

function reverseImpactResource700(graph, resourceId) {
  const requirements = mapById700(graph.requirements);
  const resources = mapById700(graph.resources);
  if (!resources.has(resourceId)) return new Set();
  const queue = [resourceId];
  const seenResources = new Set(queue);
  const requirementSeeds = new Set();
  const relations = graph.relations.filter((r) => J3_STATE_RELATIONS_700.has(r.kind));
  while (queue.length) {
    const node = queue.shift();
    for (const relation of relations) {
      if (relation.to !== node) continue;
      if (requirements.has(relation.from)) requirementSeeds.add(relation.from);
      else if (resources.has(relation.from) && !seenResources.has(relation.from)) {
        seenResources.add(relation.from);
        queue.push(relation.from);
      }
    }
  }
  return requirementImpactClosure700(graph, requirementSeeds);
}

function affectedRequirements700(delta, graph) {
  const requirements = mapById700(graph.requirements);
  const resources = mapById700(graph.resources);
  const seeds = new Set();

  if (delta.kind.startsWith("requirement_") || delta.kind === "lifecycle") {
    if (requirements.has(delta.subject)) seeds.add(delta.subject);
  } else if (delta.kind.startsWith("resource_") || delta.kind === "dependency_update") {
    for (const id of reverseImpactResource700(graph, delta.subject)) seeds.add(id);
  } else if (delta.kind.startsWith("relation_") && delta.relation) {
    for (const endpoint of [delta.relation.from, delta.relation.to]) {
      if (requirements.has(endpoint)) seeds.add(endpoint);
      if (resources.has(endpoint)) for (const id of reverseImpactResource700(graph, endpoint)) seeds.add(id);
    }
  }

  return requirementImpactClosure700(graph, seeds);
}

function resourceForDelta700(delta, base, head) {
  return mapById700(head.resources).get(delta.subject) || mapById700(base.resources).get(delta.subject) || null;
}

function transitionRuleMatches700(requirement, delta, base, head) {
  const rule = requirement.transition;
  if (!rule) return false;
  if (Array.isArray(rule.deltaKinds) && !rule.deltaKinds.includes(delta.kind)) return false;
  if (Array.isArray(rule.relationKinds) && delta.relation && !rule.relationKinds.includes(delta.relation.kind)) return false;
  if (Array.isArray(rule.resourceKinds)) {
    const resource = resourceForDelta700(delta, base, head);
    if (!resource || !rule.resourceKinds.includes(resource.kind)) return false;
  }
  return true;
}

function exactPermission700(context, permission) {
  return (context.trustedReceipts || []).some((receipt) =>
    receipt.baseSha === context.baseSha
    && receipt.headSha === context.headSha
    && (receipt.permissions.includes("*") || receipt.permissions.includes(permission)));
}

function applicableRequirements700(delta, base, head) {
  const impacted = new Set([
    ...affectedRequirements700(delta, base),
    ...affectedRequirements700(delta, head),
  ]);
  for (const requirement of base.requirements) {
    if (transitionRuleMatches700(requirement, delta, base, head)) impacted.add(requirement.id);
  }
  return impacted;
}

function relationTrustPermissions700(delta, base, head) {
  if (!delta.relation) return [];
  const relation = delta.relation;
  const baseRequirements = mapById700(base.requirements);
  const headRequirements = mapById700(head.requirements);
  const fromBase = baseRequirements.get(relation.from);
  const fromHead = headRequirements.get(relation.from);
  const toBase = baseRequirements.get(relation.to);

  if (J3_REQUIREMENT_RELATIONS_700.has(relation.kind)) {
    if (delta.kind === "relation_add" && !fromBase && fromHead?.normative !== false) {
      return ["requirement:" + relation.from];
    }
    if (
      delta.kind === "relation_add"
      && relation.kind === "derives_from"
      && !fromBase
      && fromHead?.normative === false
      && toBase?.allowDerivedRequirements === true
    ) return [];
    return ["relation:" + relationKey700(relation)];
  }

  if (delta.kind === "relation_remove" && relation.kind === "requires" && (fromBase?.protected || fromHead?.protected)) {
    return ["requirement:" + relation.from];
  }
  return [];
}

function trustPermissions700(delta, base, head) {
  const permissions = [];
  const baseRequirements = mapById700(base.requirements);
  const headRequirements = mapById700(head.requirements);
  const baseResources = mapById700(base.resources);
  const headResources = mapById700(head.resources);

  if (delta.kind.startsWith("requirement_")) {
    const requirement = baseRequirements.get(delta.subject) || headRequirements.get(delta.subject);
    if (requirement?.normative !== false) permissions.push("requirement:" + delta.subject);
  }
  if (delta.kind.startsWith("relation_")) permissions.push(...relationTrustPermissions700(delta, base, head));
  if (delta.kind.startsWith("resource_") || delta.kind === "dependency_update") {
    const resource = baseResources.get(delta.subject) || headResources.get(delta.subject);
    if (resource?.trustRoot) permissions.push("trust_root:" + delta.subject);
  }
  if (delta.kind === "lifecycle" && ["accepted", "current", "published"].includes(delta.field)
    && (delta.before === true || delta.after === true)) {
    permissions.push("lifecycle:" + delta.subject + ":" + delta.field);
  }
  return [...new Set(permissions)].sort();
}

function reachableResourcesFromRequirement700(graph, requirementId) {
  const resources = mapById700(graph.resources);
  const reached = new Set();
  const queue = [requirementId];
  const seen = new Set(queue);
  while (queue.length) {
    const node = queue.shift();
    for (const relation of graph.relations) {
      if (!J3_STATE_RELATIONS_700.has(relation.kind) || relation.from !== node || seen.has(relation.to)) continue;
      if (!resources.has(relation.to)) continue;
      seen.add(relation.to);
      reached.add(relation.to);
      queue.push(relation.to);
    }
  }
  return reached;
}

function exactExecutionPass700(context, resourceId) {
  return (context.executions || []).some((execution) =>
    execution.resourceId === resourceId
    && execution.baseSha === context.baseSha
    && execution.headSha === context.headSha
    && execution.status === "pass");
}

function exactDomainPass700(context, requirementId, kind, subject = requirementId) {
  return (context.domainEvidence || []).some((evidence) =>
    evidence.requirementId === requirementId
    && evidence.kind === kind
    && evidence.subject === subject
    && evidence.baseSha === context.baseSha
    && evidence.headSha === context.headSha
    && evidence.status === "pass");
}

function metricValue700(constraint, requirementId, base, head, deltas, context) {
  const scopeGraph = mapById700(head.requirements).has(requirementId) ? head : base;
  const scope = reachableResourcesFromRequirement700(scopeGraph, requirementId);
  if (constraint.metric === "changed_lines") {
    return deltas
      .filter((delta) => (delta.kind.startsWith("resource_") || delta.kind === "dependency_update") && scope.has(delta.subject))
      .reduce((sum, delta) => sum + Number(context.metrics?.changedLines?.[delta.subject] || 0), 0);
  }
  if (constraint.metric === "new_files") {
    return deltas.filter((delta) => delta.kind === "resource_add" && scope.has(delta.subject)
      && mapById700(head.resources).get(delta.subject)?.tracked !== false).length;
  }
  if (constraint.metric === "new_docs") {
    return deltas.filter((delta) => delta.kind === "resource_add" && scope.has(delta.subject)
      && mapById700(head.resources).get(delta.subject)?.kind === "doc").length;
  }
  throw new Error("unsupported #700 metric " + constraint.metric);
}

function evaluate700({
  base,
  head,
  baseSha = "a".repeat(40),
  headSha = "b".repeat(40),
  workIntent = wi700([]),
  trustedReceipts = [],
  executions = [],
  domainEvidence = [],
  externalObservations = [],
  metrics = {},
  legacyGlobalBudget = null,
}) {
  const context = { baseSha, headSha, workIntent, trustedReceipts, executions, domainEvidence, externalObservations, metrics, legacyGlobalBudget };
  const state = validateHead700(head);
  const baseJ2 = j2Closure700(base);
  const deltas = transitionDeltas700(base, head);
  const j3Violations = [];
  const trustViolations = [];
  const evidenceViolations = [];
  const constraintViolations = [];
  const changedExplanations = [];
  const applicableAll = new Set();
  const affectedAll = new Set();

  for (const delta of deltas) {
    const applicable = applicableRequirements700(delta, base, head);
    const affected = new Set([
      ...affectedRequirements700(delta, base),
      ...affectedRequirements700(delta, head),
    ]);
    for (const id of applicable) applicableAll.add(id);
    for (const id of affected) affectedAll.add(id);

    const causes = [...applicable].filter((id) =>
      workIntent.addresses.includes(id)
      && (baseJ2.paths.has(id) || exactPermission700(context, "requirement:" + id))
    ).sort();

    if (!causes.length) j3Violations.push("J3:no_cause:" + delta.kind + ":" + delta.subject);

    const permissions = trustPermissions700(delta, base, head);
    for (const permission of permissions) {
      if (!exactPermission700(context, permission)) trustViolations.push("TRUST:missing:" + permission);
    }

    changedExplanations.push({
      delta: delta.kind + ":" + delta.subject + (delta.field ? ":" + delta.field : ""),
      affected: [...affected].sort(),
      applicable: [...applicable].sort(),
      causes,
      trust: permissions,
    });
  }

  const relationExists = (from, kind, to) =>
    base.relations.some((r) => r.from === from && r.kind === kind && r.to === to)
    || head.relations.some((r) => r.from === from && r.kind === kind && r.to === to);

  for (const id of [...applicableAll].sort()) {
    const requirement = mapById700(base.requirements).get(id) || mapById700(head.requirements).get(id);
    if (!requirement) continue;

    for (const verifier of requirement.requiredVerifiers || []) {
      if (!relationExists(id, "verified_by", verifier)) {
        evidenceViolations.push("EVIDENCE:unrelated_verifier:" + id + ":" + verifier);
      } else if (!exactExecutionPass700(context, verifier)) {
        evidenceViolations.push("EVIDENCE:verifier_not_passed:" + id + ":" + verifier);
      }
    }

    for (const kind of requirement.domainEvidenceOnChange || []) {
      if (!exactDomainPass700(context, id, kind)) {
        evidenceViolations.push("DOMAIN:missing:" + id + ":" + kind);
      }
    }

    if (requirement.acknowledgeImpact === true && affectedAll.has(id) && !workIntent.addresses.includes(id)) {
      evidenceViolations.push("IMPACT:unacknowledged:" + id);
    }

    for (const constraint of requirement.constraints || []) {
      const actual = metricValue700(constraint, id, base, head, deltas, context);
      const permission = "constraint:" + id + ":" + constraint.id;
      if (actual > constraint.max && !exactPermission700(context, permission)) {
        constraintViolations.push("CONSTRAINT:" + id + ":" + constraint.id + ":" + actual + ">" + constraint.max);
      }
    }
  }

  const changedResourceIds = new Set(
    deltas
      .filter((delta) => delta.kind.startsWith("resource_") || delta.kind === "dependency_update")
      .map((delta) => delta.subject)
  );
  const generationRelations = new Map();
  for (const relation of [...base.relations, ...head.relations]) {
    if (relation.kind === "generates") generationRelations.set(relationKey700(relation), relation);
  }
  for (const relation of [...generationRelations.values()].sort((a, b) => relationKey700(a).localeCompare(relationKey700(b)))) {
    if (!changedResourceIds.has(relation.from) && !changedResourceIds.has(relation.to)) continue;
    const owner = [...applicableAll].find((id) => reachableResourcesFromRequirement700(head, id).has(relation.from)
      || reachableResourcesFromRequirement700(base, id).has(relation.from));
    if (!owner || !exactDomainPass700(context, owner, "generation_freshness", relationKey700(relation))) {
      evidenceViolations.push("DOMAIN:generation_freshness:" + relationKey700(relation));
    }
  }

  for (const delta of deltas.filter((item) => item.kind === "dependency_update")) {
    const resource = mapById700(head.resources).get(delta.subject);
    const observed = externalObservations.some((item) =>
      item.resourceId === delta.subject && item.exact === resource?.exact && item.status === "resolved");
    if (!observed) evidenceViolations.push("OBSERVATION:dependency_unresolved:" + delta.subject);
  }

  const reasons = [
    ...state.reasons,
    ...new Set(j3Violations),
    ...new Set(trustViolations),
    ...new Set(evidenceViolations),
    ...new Set(constraintViolations),
  ].sort();

  return {
    ok: reasons.length === 0,
    reasons,
    deltas,
    affectedRequirements: [...affectedAll].sort(),
    applicableRequirements: [...applicableAll].sort(),
    explanations: {
      whyRequirement: Object.fromEntries([...state.j2.paths.entries()].sort(([a], [b]) => a.localeCompare(b))),
      whyResource: Object.fromEntries([...state.j1.paths.entries()].sort(([a], [b]) => a.localeCompare(b))),
      whyChanged: changedExplanations.sort((a, b) => a.delta.localeCompare(b.delta)),
      quantitative: [...applicableAll].sort().flatMap((id) => {
        const requirement = mapById700(base.requirements).get(id) || mapById700(head.requirements).get(id);
        return (requirement?.constraints || []).map((constraint) => ({
          requirement: id,
          constraint: constraint.id,
          metric: constraint.metric,
          actual: metricValue700(constraint, id, base, head, deltas, context),
          max: constraint.max,
        }));
      }),
    },
  };
}

function assert700(label, input, expected, includes = []) {
  const result = evaluate700(input);
  assert.equal(result.ok, expected, label + ": " + result.reasons.join(", "));
  for (const fragment of includes) {
    assert.ok(result.reasons.some((reason) => reason.includes(fragment)), label + ": missing reason " + fragment);
  }
  return result;
}

test("#700 S01 new Requirement + implementation is atomic without self-authorization", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true })],
  });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true }), req700("R-NEW")],
    resources: [res700("F-NEW")],
    relations: [
      rel700("R-NEW", "derives_from", "ROOT"),
      rel700("R-NEW", "implemented_by", "F-NEW"),
    ],
  });
  const result = assert700("S01", {
    base, head,
    workIntent: wi700(["ROOT", "R-NEW"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R-NEW"])],
  }, true);
  assert.ok(result.explanations.whyResource["F-NEW"].includes("R-NEW"));
});

test("#700 S02 new Requirement may be satisfied by existing implementation with ArtifactDelta empty", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true })],
    resources: [res700("F")],
    relations: [rel700("ROOT", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true }), req700("R-NEW")],
    resources: [res700("F")],
    relations: [
      rel700("ROOT", "implemented_by", "F"),
      rel700("R-NEW", "derives_from", "ROOT"),
      rel700("R-NEW", "implemented_by", "F"),
    ],
  });
  const result = assert700("S02", {
    base, head,
    workIntent: wi700(["ROOT", "R-NEW"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R-NEW"])],
  }, true);
  assert.equal(result.deltas.some((delta) => delta.kind.startsWith("resource_")), false);
});

test("#700 S03 bugfix may change implementation with RequirementDelta empty", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("F", "code", { content: "bug" })],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("F", "code", { content: "fixed" })],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const result = assert700("S03", { base, head, workIntent: wi700(["R1"]) }, true);
  assert.equal(result.deltas.some((delta) => delta.kind.startsWith("requirement_")), false);
});

test("#700 S04 pure refactor uses a project/process Requirement instead of fake product Requirements", () => {
  const base = graph700({
    roots: ["R-PRODUCT", "R-MAINT"],
    requirements: [
      req700("R-PRODUCT"),
      req700("R-MAINT", {
        transition: { deltaKinds: ["resource_modify"], resourceKinds: ["code"] },
        domainEvidenceOnChange: ["equivalence"],
      }),
    ],
    resources: [res700("F", "code", { content: "before" })],
    relations: [rel700("R-PRODUCT", "implemented_by", "F")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [res700("F", "code", { content: "after" })],
    relations: base.relations,
  });
  assert700("S04", {
    base, head,
    workIntent: wi700(["R-MAINT"]),
    domainEvidence: [{ requirementId: "R-MAINT", kind: "equivalence", subject: "R-MAINT", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" }],
  }, true);
});

test("#700 S05 Requirement change does not force an artifact delta when existing implementation satisfies HEAD", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { semantic: "v1", protected: true })],
    resources: [res700("F")],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { semantic: "v2", protected: true })],
    resources: [res700("F")],
    relations: base.relations,
  });
  const result = assert700("S05", {
    base, head,
    workIntent: wi700(["R1"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"])],
  }, true);
  assert.equal(result.deltas.some((delta) => delta.kind.startsWith("resource_")), false);
});

test("#700 S06 removing a Requirement does not delete shared implementation still justified by another Requirement", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [req700("R1"), req700("R2")],
    resources: [res700("F")],
    relations: [rel700("R1", "implemented_by", "F"), rel700("R2", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["R2"],
    requirements: [req700("R2")],
    resources: [res700("F")],
    relations: [rel700("R2", "implemented_by", "F")],
  });
  const result = assert700("S06", {
    base, head,
    workIntent: wi700(["R1"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"])],
  }, true);
  assert.equal(result.deltas.some((delta) => delta.kind === "resource_delete"), false);
});

test("#700 S07 implementation replacement + relation replacement has a finite routine J3 path", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("OLD")],
    relations: [rel700("R1", "implemented_by", "OLD")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("NEW")],
    relations: [rel700("R1", "implemented_by", "NEW")],
  });
  const result = assert700("S07", { base, head, workIntent: wi700(["R1"]) }, true);
  assert.ok(result.deltas.some((delta) => delta.kind === "relation_remove"));
  assert.ok(result.deltas.some((delta) => delta.kind === "relation_add"));
});

test("#700 S08 rename/move preserves semantic resource identity while changing locator", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("F", "code", { locator: "src/old.mts", content: "same" })],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("F", "code", { locator: "src/new.mts", content: "same" })],
    relations: base.relations,
  });
  const result = assert700("S08", { base, head, workIntent: wi700(["R1"]) }, true);
  assert.deepEqual(result.deltas.map((delta) => delta.kind), ["resource_rename"]);
});

test("#700 S09 shared resource change evaluates reverse impact for all linked Requirements without generic cochange", () => {
  const base = graph700({
    roots: ["R1", "R2", "R3"],
    requirements: [
      req700("R1"),
      req700("R2", { requiredVerifiers: ["T2"] }),
      req700("R3"),
    ],
    resources: [
      res700("F", "code", { content: "before" }),
      res700("T2", "test"),
    ],
    relations: [
      rel700("R1", "implemented_by", "F"),
      rel700("R2", "implemented_by", "F"),
      rel700("R3", "implemented_by", "F"),
      rel700("R2", "verified_by", "T2"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [res700("F", "code", { content: "after" }), res700("T2", "test")],
    relations: base.relations,
  });
  const result = assert700("S09", {
    base, head, workIntent: wi700(["R1"]),
    executions: [{ resourceId: "T2", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" }],
  }, true);
  assert.deepEqual(result.affectedRequirements, ["R1", "R2", "R3"]);
  assert.equal(result.deltas.some((delta) => delta.subject === "T2"), false);
});

test("#700 S10 one Requirement may have multiple implementations and multiple verifier resources", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { requiredVerifiers: ["T1", "T2"] })],
    resources: [
      res700("F1", "code", { content: "a" }),
      res700("F2", "code", { content: "a" }),
      res700("T1", "test"),
      res700("T2", "test"),
    ],
    relations: [
      rel700("R1", "implemented_by", "F1"),
      rel700("R1", "implemented_by", "F2"),
      rel700("R1", "verified_by", "T1"),
      rel700("R1", "verified_by", "T2"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [
      res700("F1", "code", { content: "b" }),
      res700("F2", "code", { content: "b" }),
      res700("T1", "test"),
      res700("T2", "test"),
    ],
    relations: base.relations,
  });
  assert700("S10", {
    base, head, workIntent: wi700(["R1"]),
    executions: [
      { resourceId: "T1", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" },
      { resourceId: "T2", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" },
    ],
  }, true);
});

test("#700 S11 quality Requirement may affect code through constraint and architecture/design hops without direct code edge", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT"), req700("R-FUNC"), req700("R-QUALITY")],
    resources: [
      res700("ARCH", "architecture"),
      res700("DESIGN", "design"),
      res700("CODE", "code", { content: "before" }),
    ],
    relations: [
      rel700("R-FUNC", "derives_from", "ROOT"),
      rel700("R-QUALITY", "derives_from", "ROOT"),
      rel700("R-QUALITY", "constrains", "R-FUNC"),
      rel700("R-FUNC", "implemented_by", "ARCH"),
      rel700("ARCH", "implemented_by", "DESIGN"),
      rel700("DESIGN", "implemented_by", "CODE"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [
      res700("ARCH", "architecture"),
      res700("DESIGN", "design"),
      res700("CODE", "code", { content: "after" }),
    ],
    relations: base.relations,
  });
  const result = assert700("S11", { base, head, workIntent: wi700(["R-FUNC"]) }, true);
  assert.ok(result.affectedRequirements.includes("R-QUALITY"));
  assert.equal(base.relations.some((r) => r.from === "R-QUALITY" && r.to === "CODE"), false);
});

test("#700 S12 merged proposed research remains distinct from ACCEPTED and CURRENT", () => {
  const base = graph700({
    roots: ["R-RESEARCH-ROOT"],
    requirements: [req700("R-RESEARCH-ROOT", { allowDerivedRequirements: true })],
  });
  const head = graph700({
    roots: base.roots,
    requirements: [base.requirements[0], req700("R-PROPOSED", { normative: false })],
    resources: [res700("EXP", "experiment")],
    relations: [
      rel700("R-PROPOSED", "derives_from", "R-RESEARCH-ROOT"),
      rel700("R-PROPOSED", "implemented_by", "EXP"),
    ],
    lifecycle: { "R-PROPOSED": { merged: true, accepted: false, current: false } },
  });
  assert700("S12", { base, head, workIntent: wi700(["R-RESEARCH-ROOT"]) }, true);
  assert.equal(head.lifecycle["R-PROPOSED"].accepted, false);
  assert.equal(head.lifecycle["R-PROPOSED"].current, false);
});

test("#700 S13 stacked PRs may partially fulfill one Requirement without a whole-requirement cochange gate", () => {
  const base = graph700({ roots: ["R1"], requirements: [req700("R1")] });
  const middle = graph700({
    roots: ["R1"], requirements: [req700("R1")],
    resources: [res700("F1")],
    relations: [rel700("R1", "implemented_by", "F1")],
  });
  const final = graph700({
    roots: ["R1"], requirements: [req700("R1")],
    resources: [res700("F1"), res700("F2")],
    relations: [rel700("R1", "implemented_by", "F1"), rel700("R1", "implemented_by", "F2")],
  });
  assert700("S13.1", { base, head: middle, workIntent: wi700(["R1"]) }, true);
  assert700("S13.2", {
    base: middle, head: final, baseSha: "b".repeat(40), headSha: "c".repeat(40), workIntent: wi700(["R1"]),
  }, true);
});

test("#700 S14 scope discovered mid-PR is recoverable by extending WorkIntent, not recreating the PR", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [req700("R1"), req700("R2")],
    resources: [res700("F2", "code", { content: "before" })],
    relations: [rel700("R2", "implemented_by", "F2")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [res700("F2", "code", { content: "after" })],
    relations: base.relations,
  });
  assert700("S14 initial", { base, head, workIntent: wi700(["R1"]) }, false, ["J3:no_cause"]);
  assert700("S14 extended", { base, head, workIntent: wi700(["R1", "R2"]) }, true);
});

test("#700 S15 mechanical mass refactor uses DOMAIN equivalence evidence instead of fake per-file Requirements", () => {
  const base = graph700({
    roots: ["R1", "R2", "R-MAINT"],
    requirements: [
      req700("R1"),
      req700("R2"),
      req700("R-MAINT", {
        transition: { deltaKinds: ["resource_modify"], resourceKinds: ["code"] },
        domainEvidenceOnChange: ["equivalence"],
      }),
    ],
    resources: [res700("F1", "code", { content: "a" }), res700("F2", "code", { content: "a" })],
    relations: [rel700("R1", "implemented_by", "F1"), rel700("R2", "implemented_by", "F2")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [res700("F1", "code", { content: "b" }), res700("F2", "code", { content: "b" })],
    relations: base.relations,
  });
  assert700("S15", {
    base, head, workIntent: wi700(["R-MAINT"]),
    domainEvidence: [{ requirementId: "R-MAINT", kind: "equivalence", subject: "R-MAINT", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" }],
  }, true);
});

test("#700 S16 dependency/security update uses maintenance cause and exact dependency observation", () => {
  const base = graph700({
    roots: ["R-APP", "R-SEC"],
    requirements: [
      req700("R-APP"),
      req700("R-SEC", { transition: { deltaKinds: ["dependency_update", "resource_modify"], resourceKinds: ["external_dependency", "lockfile"] } }),
    ],
    resources: [
      res700("DEP", "external_dependency", { tracked: false, exact: "dep-a", content: "same" }),
      res700("LOCK", "lockfile", { content: "dep-a" }),
    ],
    relations: [
      rel700("R-APP", "requires", "DEP"),
      rel700("R-APP", "requires", "LOCK"),
      rel700("R-APP", "depends_on", "R-SEC"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [
      res700("DEP", "external_dependency", { tracked: false, exact: "dep-b", content: "same" }),
      res700("LOCK", "lockfile", { content: "dep-b" }),
    ],
    relations: base.relations,
  });
  assert700("S16", {
    base, head, workIntent: wi700(["R-SEC"], { source: "security_advisory" }),
    externalObservations: [{ resourceId: "DEP", exact: "dep-b", status: "resolved" }],
  }, true);
});

test("#700 S17 generated source/projection transition requires exact generation freshness evidence", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [
      res700("SRC", "source", { content: "a" }),
      res700("GEN", "generated", { content: "A" }),
    ],
    relations: [rel700("R1", "requires", "SRC"), rel700("SRC", "generates", "GEN")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [
      res700("SRC", "source", { content: "b" }),
      res700("GEN", "generated", { content: "B" }),
    ],
    relations: base.relations,
  });
  assert700("S17", {
    base, head, workIntent: wi700(["R1"]),
    domainEvidence: [{
      requirementId: "R1",
      kind: "generation_freshness",
      subject: relationKey700(rel700("SRC", "generates", "GEN")),
      baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass",
    }],
  }, true);
});

test("#700 S18 rebase recomputes exact authority; stale receipt fails and fresh receipt restores liveness", () => {
  const base = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v1", protected: true })] });
  const head = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v2", protected: true })] });
  const oldReceipt = receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"]);
  assert700("S18 original", { base, head, workIntent: wi700(["R1"]), trustedReceipts: [oldReceipt] }, true);
  assert700("S18 stale", {
    base, head, baseSha: "c".repeat(40), headSha: "d".repeat(40), workIntent: wi700(["R1"]), trustedReceipts: [oldReceipt],
  }, false, ["TRUST:missing:requirement:R1"]);
  assert700("S18 fresh", {
    base, head, baseSha: "c".repeat(40), headSha: "d".repeat(40), workIntent: wi700(["R1"]),
    trustedReceipts: [receipt700("c".repeat(40), "d".repeat(40), ["requirement:R1"])],
  }, true);
});

test("#700 S19 cross-repo exact immutable dependency update needs no atomic multi-repo commit", () => {
  const base = graph700({
    roots: ["R-DEP"],
    requirements: [req700("R-DEP", { transition: { deltaKinds: ["dependency_update", "resource_modify"], resourceKinds: ["external_dependency", "manifest"] } })],
    resources: [
      res700("EXT", "external_dependency", { tracked: false, exact: "repo@111", content: "same" }),
      res700("MANIFEST", "manifest", { content: "repo@111" }),
    ],
    relations: [rel700("R-DEP", "requires", "EXT"), rel700("R-DEP", "requires", "MANIFEST")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [
      res700("EXT", "external_dependency", { tracked: false, exact: "repo@222", content: "same" }),
      res700("MANIFEST", "manifest", { content: "repo@222" }),
    ],
    relations: base.relations,
  });
  assert700("S19", {
    base, head, workIntent: wi700(["R-DEP"]),
    externalObservations: [{ resourceId: "EXT", exact: "repo@222", status: "resolved" }],
  }, true);
});

test("#700 S20 orphan cleanup is justified by repository-integrity Requirement; UNJUSTIFIED is not deletion authority", () => {
  const base = graph700({
    roots: ["R-INTEGRITY"],
    requirements: [req700("R-INTEGRITY", { transition: { deltaKinds: ["resource_delete"] } })],
    resources: [res700("ORPHAN", "unknown")],
  });
  const head = graph700({
    roots: ["R-INTEGRITY"],
    requirements: base.requirements,
    resources: [],
  });
  assert.equal(validateHead700(base).ok, false, "fixture must start with an observed orphan");
  assert700("S20", { base, head, workIntent: wi700(["R-INTEGRITY"]) }, true);
  assert700("S20 no cause", { base, head, workIntent: wi700([]) }, false, ["J3:no_cause"]);
});

test("#700 S21 security-sensitive work does not require a public Issue", () => {
  const base = graph700({
    roots: ["R-PRODUCT", "R-SECURITY"],
    requirements: [
      req700("R-PRODUCT"),
      req700("R-SECURITY", {
        transition: { deltaKinds: ["resource_modify"], resourceKinds: ["code"] },
        domainEvidenceOnChange: ["security_review"],
      }),
    ],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R-PRODUCT", "implemented_by", "F")],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" })], relations: base.relations,
  });
  assert700("S21", {
    base, head,
    workIntent: wi700(["R-SECURITY"], { source: "security_advisory", state: "private" }),
    domainEvidence: [{ requirementId: "R-SECURITY", kind: "security_review", subject: "R-SECURITY", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "pass" }],
  }, true);
});

test("#700 S22 closing an Issue does not destroy an exact trusted decision receipt", () => {
  const base = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v1", protected: true })] });
  const head = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v2", protected: true })] });
  assert700("S22", {
    base, head,
    workIntent: wi700(["R1"], { source: "issue", state: "closed" }),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"])],
  }, true);
});

test("#700 R23 candidate-created fake Requirement cannot be the sole cause for garbage", () => {
  const base = graph700({ roots: ["ROOT"], requirements: [req700("ROOT")] });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT"), req700("R-GARBAGE")],
    resources: [res700("GARBAGE", "unknown")],
    relations: [rel700("R-GARBAGE", "requires", "GARBAGE")],
  });
  assert700("R23", { base, head, workIntent: wi700(["R-GARBAGE"]) }, false, ["J2:orphan_requirement", "J3:no_cause"]);
});

test("#700 R24 candidate cannot remove governing Requirement to authorize its own protected change", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true }), req700("R-GOV", { protected: true })],
    resources: [res700("WORKFLOW", "workflow", { trustRoot: true, content: "safe" })],
    relations: [
      rel700("R-GOV", "derives_from", "ROOT"),
      rel700("R-GOV", "requires", "WORKFLOW"),
    ],
  });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true }), req700("R-ALLOW")],
    resources: [res700("WORKFLOW", "workflow", { trustRoot: true, content: "candidate" })],
    relations: [
      rel700("R-ALLOW", "derives_from", "ROOT"),
      rel700("R-ALLOW", "requires", "WORKFLOW"),
    ],
  });
  assert700("R24", { base, head, workIntent: wi700(["R-ALLOW"]) }, false, ["TRUST:missing:requirement:R-GOV", "TRUST:missing:trust_root:WORKFLOW"]);
});

test("#700 R25 candidate cannot self-mark ACCEPTED/CURRENT", () => {
  const base = graph700({ roots: ["R1"], requirements: [req700("R1")], lifecycle: { R1: { accepted: false, current: false } } });
  const head = graph700({ roots: ["R1"], requirements: [req700("R1")], lifecycle: { R1: { accepted: true, current: true } } });
  assert700("R25", { base, head, workIntent: wi700(["R1"]) }, false, ["TRUST:missing:lifecycle:R1:accepted", "TRUST:missing:lifecycle:R1:current"]);
});

test("#700 R26 candidate cannot change trusted provider/workflow identity through ordinary project relation", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("TRUST-WORKFLOW", "workflow", { trustRoot: true, content: "trusted" })],
    relations: [rel700("R1", "requires", "TRUST-WORKFLOW")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1")],
    resources: [res700("TRUST-WORKFLOW", "workflow", { trustRoot: true, content: "candidate" })],
    relations: [rel700("R1", "requires", "TRUST-WORKFLOW"), rel700("R1", "documents", "TRUST-WORKFLOW")],
  });
  assert700("R26", { base, head, workIntent: wi700(["R1"]) }, false, ["TRUST:missing:trust_root:TRUST-WORKFLOW"]);
});

test("#700 R27 stale exact authorization cannot be replayed after rebase", () => {
  const base = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v1", protected: true })] });
  const head = graph700({ roots: ["R1"], requirements: [req700("R1", { semantic: "v2", protected: true })] });
  assert700("R27", {
    base, head, baseSha: "c".repeat(40), headSha: "d".repeat(40), workIntent: wi700(["R1"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"])],
  }, false, ["TRUST:missing:requirement:R1"]);
});

test("#700 R28 superseded/historical evidence cannot be deleted while protected retention obligation is removed without authority", () => {
  const base = graph700({
    roots: ["R-HISTORY"],
    requirements: [req700("R-HISTORY", { protected: true })],
    resources: [res700("HIST", "evidence")],
    relations: [rel700("R-HISTORY", "requires", "HIST")],
  });
  const head = graph700({
    roots: ["R-HISTORY"],
    requirements: base.requirements,
    resources: [],
    relations: [],
  });
  assert700("R28", { base, head, workIntent: wi700(["R-HISTORY"]) }, false, ["TRUST:missing:requirement:R-HISTORY"]);
});

test("#700 R29 shared resource reverse impact cannot ignore another Requirement's applicable verifier obligation", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [req700("R1"), req700("R2", { requiredVerifiers: ["T2"] })],
    resources: [res700("F", "code", { content: "a" }), res700("T2", "test")],
    relations: [
      rel700("R1", "implemented_by", "F"),
      rel700("R2", "implemented_by", "F"),
      rel700("R2", "verified_by", "T2"),
    ],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" }), res700("T2", "test")], relations: base.relations,
  });
  const result = assert700("R29", { base, head, workIntent: wi700(["R1"]) }, false, ["EVIDENCE:verifier_not_passed:R2:T2"]);
  assert.deepEqual(result.affectedRequirements, ["R1", "R2"]);
});

test("#700 R30 verified_by trace does not satisfy required exact verifier execution when FAIL/not-run", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { requiredVerifiers: ["T"] })],
    resources: [res700("F", "code", { content: "a" }), res700("T", "test")],
    relations: [rel700("R1", "implemented_by", "F"), rel700("R1", "verified_by", "T")],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" }), res700("T", "test")], relations: base.relations,
  });
  assert700("R30 fail", {
    base, head, workIntent: wi700(["R1"]),
    executions: [{ resourceId: "T", baseSha: "a".repeat(40), headSha: "b".repeat(40), status: "fail" }],
  }, false, ["EVIDENCE:verifier_not_passed:R1:T"]);
  assert700("R30 not-run", { base, head, workIntent: wi700(["R1"]) }, false, ["EVIDENCE:verifier_not_passed:R1:T"]);
});

test("#700 R31 legacy global line budget is not a blocker without an applicable Requirement constraint", () => {
  const base = graph700({
    roots: ["R1"], requirements: [req700("R1")],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" })], relations: base.relations,
  });
  const result = assert700("R31 target", {
    base, head, workIntent: wi700(["R1"]),
    metrics: { changedLines: { F: 5000 } },
    legacyGlobalBudget: { max_net_added_lines: 100 },
  }, true);
  assert.deepEqual(result.explanations.quantitative, []);
});

test("#700 R32 Requirement change does not mechanically force all linked resources to change", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { semantic: "v1" })],
    resources: [res700("F1"), res700("F2")],
    relations: [rel700("R1", "implemented_by", "F1"), rel700("R1", "implemented_by", "F2")],
  });
  const head = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { semantic: "v2" })],
    resources: base.resources,
    relations: base.relations,
  });
  const result = assert700("R32 target", {
    base, head,
    workIntent: wi700(["R1"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R1"])],
  }, true);
  assert.equal(result.deltas.filter((delta) => delta.kind.startsWith("resource_")).length, 0);
});

test("#700 D9 multiple Requirement-scoped quantitative constraints are evaluated on their own derived sets", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [
      req700("R1", { constraints: [{ id: "lines-r1", metric: "changed_lines", max: 500 }] }),
      req700("R2", { constraints: [{ id: "lines-r2", metric: "changed_lines", max: 5000 }] }),
    ],
    resources: [res700("F1", "code", { content: "a" }), res700("F2", "generated", { content: "a" })],
    relations: [rel700("R1", "implemented_by", "F1"), rel700("R2", "implemented_by", "F2")],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F1", "code", { content: "b" }), res700("F2", "generated", { content: "b" })],
    relations: base.relations,
  });
  const result = assert700("D9", {
    base, head, workIntent: wi700(["R1", "R2"]),
    metrics: { changedLines: { F1: 400, F2: 4000 } },
  }, true);
  assert.deepEqual(result.explanations.quantitative.map((item) => [item.requirement, item.actual, item.max]), [
    ["R1", 400, 500],
    ["R2", 4000, 5000],
  ]);
});

test("#700 D9 exact one-shot constraint waiver is Transition-bound and does not become a profile", () => {
  const base = graph700({
    roots: ["R1"],
    requirements: [req700("R1", { constraints: [{ id: "lines", metric: "changed_lines", max: 100 }] })],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R1", "implemented_by", "F")],
  });
  const head = graph700({
    roots: base.roots, requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" })], relations: base.relations,
  });
  assert700("D9 no waiver", {
    base, head, workIntent: wi700(["R1"]), metrics: { changedLines: { F: 150 } },
  }, false, ["CONSTRAINT:R1:lines"]);
  assert700("D9 exact waiver", {
    base, head, workIntent: wi700(["R1"]), metrics: { changedLines: { F: 150 } },
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["constraint:R1:lines"])],
  }, true);
  assert700("D9 stale waiver", {
    base, head, baseSha: "c".repeat(40), headSha: "d".repeat(40),
    workIntent: wi700(["R1"]), metrics: { changedLines: { F: 150 } },
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["constraint:R1:lines"])],
  }, false, ["CONSTRAINT:R1:lines"]);
});


test("#700 SAFETY RED: rooted fake Requirement must not self-justify same-HEAD garbage", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true })],
  });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [
      req700("ROOT", { allowDerivedRequirements: true }),
      req700("R-GARBAGE"),
    ],
    resources: [res700("GARBAGE", "unknown")],
    relations: [
      rel700("R-GARBAGE", "derives_from", "ROOT"),
      rel700("R-GARBAGE", "requires", "GARBAGE"),
    ],
  });

  const result = evaluate700({
    base,
    head,
    workIntent: wi700(["ROOT", "R-GARBAGE"]),
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.includes("TRUST:missing:requirement:R-GARBAGE"),
    "rooted HEAD state and candidate WorkIntent must not replace exact TRUST for a new normative Requirement",
  );

  const exactAuthorized = evaluate700({
    base,
    head,
    workIntent: wi700(["ROOT", "R-GARBAGE"]),
    trustedReceipts: [receipt700("a".repeat(40), "b".repeat(40), ["requirement:R-GARBAGE"])],
  });
  assert.equal(
    exactAuthorized.ok,
    true,
    "the same atomic new-Requirement transition becomes live only with exact independent authorization",
  );
});


test("#700 SAFETY RED: candidate cannot label a new canonical Requirement non-normative to bypass exact authority", () => {
  const base = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT", { allowDerivedRequirements: true })],
  });
  const head = graph700({
    roots: ["ROOT"],
    requirements: [
      base.requirements[0],
      req700("R-GARBAGE", { normative: false }),
    ],
    resources: [res700("GARBAGE", "unknown")],
    relations: [
      rel700("R-GARBAGE", "derives_from", "ROOT"),
      rel700("R-GARBAGE", "requires", "GARBAGE"),
    ],
  });
  assert.equal(
    evaluate700({ base, head, workIntent: wi700(["ROOT", "R-GARBAGE"]) }).ok,
    false,
    "Requirement authority class must not be candidate-controlled metadata",
  );
});

test("#700 SAFETY RED: removing an existence requires edge must not be routine weakening", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [req700("R1"), req700("R2")],
    resources: [res700("F")],
    relations: [
      rel700("R1", "requires", "F"),
      rel700("R2", "implemented_by", "F"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: base.resources,
    relations: [rel700("R2", "implemented_by", "F")],
  });
  assert.equal(
    evaluate700({ base, head, workIntent: wi700(["R1"]) }).ok,
    false,
    "candidate must not remove a BASE existence obligation merely because another Requirement still justifies the file",
  );
});

test("#700 SAFETY RED: Requirement-scoped numeric constraints use BASE union HEAD scope", () => {
  const base = graph700({
    roots: ["R1", "R2"],
    requirements: [
      req700("R1", { constraints: [{ id: "lines-r1", metric: "changed_lines", max: 100 }] }),
      req700("R2"),
    ],
    resources: [res700("F", "code", { content: "a" })],
    relations: [
      rel700("R1", "implemented_by", "F"),
      rel700("R2", "implemented_by", "F"),
    ],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [res700("F", "code", { content: "b" })],
    relations: [rel700("R2", "implemented_by", "F")],
  });
  const result = evaluate700({
    base,
    head,
    workIntent: wi700(["R1", "R2"]),
    metrics: { changedLines: { F: 150 } },
  });
  assert.equal(
    result.ok,
    false,
    "removing a HEAD trace must not erase a BASE Requirement constraint from the current Transition scope",
  );
  assert.ok(result.reasons.some((reason) => reason.includes("CONSTRAINT:R1:lines-r1")));
});
