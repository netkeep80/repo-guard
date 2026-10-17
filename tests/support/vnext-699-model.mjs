import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeDocumentFact,
  parseJson,
  parseYaml,
  resolveJsonPointer,
} from "../../dist/document-facts.mjs";
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
const req700 = (id, extra = {}) => ({ id, semantic: id, ...extra });
const res700 = (id, kind = "code", extra = {}) => ({ id, kind, tracked: true, locator: id, content: id, ...extra });
const rel700 = (from, kind, to) => ({ from, kind, to });
const wi700 = (addresses, extra = {}) => ({ id: "W", source: "pr", state: "open", addresses: [...addresses], ...extra });
const receipt700 = (baseSha, headSha, permissions) => ({ baseSha, headSha, permissions: [...permissions] });
function mapById700(items) {
  return new Map(items.map((item) => [item.id, item]));
}
function j2Closure700(graph, trustedRoots = graph.roots) {
  const requirements = mapById700(graph.requirements);
  const paths = new Map();
  for (const root of [...trustedRoots].sort()) {
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
function validateHead700(graph, trustedRoots = graph.roots) {
  const j2 = j2Closure700(graph, trustedRoots);
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
    if (before.type !== after.type || before.kind !== after.kind) {
      deltas.push({ kind: "resource_type_change", subject: id });
    }
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
function directRequirementOwners700(graph, resourceId) {
  const requirements = mapById700(graph.requirements);
  const resources = mapById700(graph.resources);
  if (!resources.has(resourceId)) return new Set();
  const queue = [resourceId];
  const seenResources = new Set(queue);
  const owners = new Set();
  const relations = graph.relations.filter((relation) => J3_STATE_RELATIONS_700.has(relation.kind));
  while (queue.length) {
    const node = queue.shift();
    for (const relation of relations) {
      if (relation.to !== node) continue;
      if (requirements.has(relation.from)) owners.add(relation.from);
      else if (resources.has(relation.from) && !seenResources.has(relation.from)) {
        seenResources.add(relation.from);
        queue.push(relation.from);
      }
    }
  }
  return owners;
}
function directRequirementsForDelta700(delta, graph) {
  const requirements = mapById700(graph.requirements);
  const resources = mapById700(graph.resources);
  const direct = new Set();
  if (delta.kind.startsWith("requirement_") || delta.kind === "lifecycle") {
    if (requirements.has(delta.subject)) direct.add(delta.subject);
  } else if (delta.kind.startsWith("resource_") || delta.kind === "dependency_update") {
    for (const id of directRequirementOwners700(graph, delta.subject)) direct.add(id);
  } else if (delta.kind.startsWith("relation_") && delta.relation) {
    for (const endpoint of [delta.relation.from, delta.relation.to]) {
      if (requirements.has(endpoint)) direct.add(endpoint);
      if (resources.has(endpoint)) {
        for (const id of directRequirementOwners700(graph, endpoint)) direct.add(id);
      }
    }
  }
  return direct;
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
    const baseResource = mapById700(base.resources).get(delta.subject);
    const headResource = mapById700(head.resources).get(delta.subject);
    const kinds = [baseResource?.kind, headResource?.kind].filter(Boolean);
    if (!kinds.some((kind) => rule.resourceKinds.includes(kind))) return false;
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
function causalRequirements700(delta, base, head) {
  const causal = new Set([
    ...directRequirementsForDelta700(delta, base),
    ...directRequirementsForDelta700(delta, head),
  ]);
  for (const requirement of base.requirements) {
    if (transitionRuleMatches700(requirement, delta, base, head)) causal.add(requirement.id);
  }
  return causal;
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
    if (delta.kind === "relation_add" && !fromBase && fromHead) {
      return ["requirement:" + relation.from];
    }
    return ["relation:" + relationKey700(relation)];
  }
  if (delta.kind === "relation_remove" && relation.kind === "requires" && fromBase) {
    return ["requirement:" + relation.from];
  }
  return [];
}
function trustPermissions700(delta, base, head, context) {
  const permissions = [];
  const baseRequirements = mapById700(base.requirements);
  const headRequirements = mapById700(head.requirements);
  if (delta.kind.startsWith("requirement_")) {
    const requirement = baseRequirements.get(delta.subject) || headRequirements.get(delta.subject);
    if (requirement) permissions.push("requirement:" + delta.subject);
  }
  if (delta.kind.startsWith("relation_")) permissions.push(...relationTrustPermissions700(delta, base, head));
  if ((delta.kind.startsWith("resource_") || delta.kind === "dependency_update")
    && context.trustedResourceIds.includes(delta.subject)) {
    permissions.push("trust_root:" + delta.subject);
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
  const scope = new Set([
    ...reachableResourcesFromRequirement700(base, requirementId),
    ...reachableResourcesFromRequirement700(head, requirementId),
  ]);
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
  authorityBase = null,
  baseSha = "a".repeat(40),
  headSha = "b".repeat(40),
  workIntent = wi700([]),
  trustedReceipts = [],
  executions = [],
  domainEvidence = [],
  externalObservations = [],
  metrics = {},
  legacyGlobalBudget = null,
  trustedRequirementRoots = null,
  trustedResourceIds = [],
}) {
  const trustedBase = authorityBase || base;
  const roots = trustedRequirementRoots || trustedBase.roots;
  const context = { baseSha, headSha, workIntent, trustedReceipts, executions, domainEvidence, externalObservations, metrics, legacyGlobalBudget, trustedResourceIds };
  const state = validateHead700(head, roots);
  const baseJ2 = j2Closure700(trustedBase, roots);
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
    const causalCandidates = causalRequirements700(delta, base, head);
    const causes = [...causalCandidates].filter((id) =>
      workIntent.addresses.includes(id)
      && (baseJ2.paths.has(id) || exactPermission700(context, "requirement:" + id))
    ).sort();
    if (!causes.length) j3Violations.push("J3:no_cause:" + delta.kind + ":" + delta.subject);
    const permissions = trustPermissions700(delta, base, head, context);
    for (const permission of permissions) {
      if (!exactPermission700(context, permission)) trustViolations.push("TRUST:missing:" + permission);
    }
    changedExplanations.push({
      delta: delta.kind + ":" + delta.subject + (delta.field ? ":" + delta.field : ""),
      affected: [...affected].sort(),
      applicable: [...applicable].sort(),
      causalCandidates: [...causalCandidates].sort(),
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
const EXACT_SHA = /^[0-9a-f]{40}$/i;
const REQUIREMENT_RELATIONS = new Set(["derives_from", "depends_on", "constrains", "supersedes"]);
const RESOURCE_RELATIONS = new Set(["requires", "implemented_by", "verified_by", "documents", "generates"]);
function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + ": must be object");
  return value;
}
function exactFields(value, allowed, label) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new Error(label + ': unknown field "' + key + '"');
  }
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + ": must be non-empty string");
  return value.trim();
}
function safePath(value, label = "path") {
  return normalizeDocumentFact(value, "repository_path", label);
}
function repositoryId(value, label = "repository") {
  const id = nonEmpty(value, label).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(id)) throw new Error(label + ": must be owner/repository");
  return id;
}
function exactRevision(value, label = "revision") {
  const revision = nonEmpty(value, label).toLowerCase();
  if (!EXACT_SHA.test(revision)) throw new Error(label + ": exact 40-hex revision required");
  return revision;
}
function pointer(value, label = "pointer") {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(label + ": must be string");
  // Reuse accepted pointer syntax validator without requiring a target.
  if (value !== "" && !value.startsWith("/")) throw new Error(label + ": malformed JSON Pointer");
  for (const raw of value === "" ? [] : value.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(raw)) throw new Error(label + ": malformed JSON Pointer escape");
  }
  return value;
}
function encodePointerSegment(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}
function strictCanonicalParse(format, content) {
  if (format === "yaml") return parseYaml(content);
  if (format === "json") {
    // JSON.parse enforces JSON grammar; YAML's unique-key parser supplies the
    // fail-closed duplicate-key property missing from raw JSON.parse.
    parseJson(content);
    return parseYaml(content);
  }
  throw new Error("unsupported canonical format " + format);
}
function canonicalFormat(path) {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  throw new Error(path + ": canonical source extension must be yaml/yml/json");
}
function snapshot({ repository = "netkeep80/repo-guard", revision = "a".repeat(40), files = {}, trackedFiles = null }) {
  const repo = repositoryId(repository);
  const sha = exactRevision(revision);
  const normalized = new Map();
  for (const [rawPath, content] of Object.entries(files)) {
    const path = safePath(rawPath, "snapshot file");
    if (normalized.has(path)) throw new Error('duplicate snapshot path "' + path + '"');
    normalized.set(path, String(content));
  }
  const tracked = (trackedFiles || [...normalized.keys()]).map((path) => safePath(path, "tracked path")).sort();
  return { repository: repo, revision: sha, files: normalized, trackedFiles: [...new Set(tracked)] };
}
function discoverCanonicalSources(snap) {
  const result = [];
  for (const path of [...snap.files.keys()].sort()) {
    safePath(path, "canonical discovery");
    if (!path.startsWith("requirements/")) continue;
    if (!/\.(?:ya?ml|json)$/.test(path)) continue;
    result.push({ path, format: canonicalFormat(path), content: snap.files.get(path) });
  }
  return result;
}
function normalizeTarget(value, label) {
  const target = object(value, label);
  if (target.kind === "requirement") {
    exactFields(target, ["kind", "id"], label);
    return { kind: "requirement", id: nonEmpty(target.id, label + ".id") };
  }
  if (target.kind === "artifact") {
    exactFields(target, ["kind", "path"], label);
    return { kind: "artifact", path: safePath(target.path, label + ".path") };
  }
  throw new Error(label + ': unsupported target kind "' + String(target.kind) + '"');
}
function parseCanonicalRequirement(source) {
  const root = object(strictCanonicalParse(source.format, source.content), source.path);
  exactFields(root, ["id", "relations"], source.path);
  const id = nonEmpty(root.id, source.path + "#/id");
  const relationsObject = root.relations === undefined ? {} : object(root.relations, source.path + "#/relations");
  const relations = [];
  for (const key of Object.keys(relationsObject).sort()) {
    const raw = object(relationsObject[key], source.path + "#/relations/" + key);
    exactFields(raw, ["predicate", "target"], source.path + "#/relations/" + key);
    const predicate = nonEmpty(raw.predicate, source.path + "#/relations/" + key + "/predicate");
    const target = normalizeTarget(raw.target, source.path + "#/relations/" + key + "/target");
    if (target.kind === "requirement" && !REQUIREMENT_RELATIONS.has(predicate)) {
      throw new Error(source.path + ": invalid Requirement relation " + predicate);
    }
    if (target.kind === "artifact" && !RESOURCE_RELATIONS.has(predicate)) {
      throw new Error(source.path + ": invalid Resource relation " + predicate);
    }
    relations.push({
      key,
      predicate,
      target,
      pointer: "/relations/" + encodePointerSegment(key),
    });
  }
  const semantic = {
    id,
    relations: relations.map(({ key, predicate, target }) => ({ key, predicate, target })),
  };
  return {
    id,
    source_path: source.path,
    source_format: source.format,
    source_sha256: sha256(source.content),
    semantic_sha256: sha256(semantic),
    semantic,
    value: root,
    relations,
  };
}
function buildSourceIndex(snap) {
  const sources = discoverCanonicalSources(snap);
  const byId = new Map();
  const byPath = new Map();
  for (const source of sources) {
    const requirement = parseCanonicalRequirement(source);
    if (byId.has(requirement.id)) {
      throw new Error('duplicate Requirement id "' + requirement.id + '" in "' + byId.get(requirement.id).source_path + '" and "' + requirement.source_path + '"');
    }
    byId.set(requirement.id, requirement);
    byPath.set(requirement.source_path, requirement.id);
  }
  for (const requirement of byId.values()) {
    for (const relation of requirement.relations) {
      if (relation.target.kind === "requirement" && !byId.has(relation.target.id)) {
        throw new Error(requirement.id + ': missing Requirement target "' + relation.target.id + '"');
      }
    }
  }
  return { snapshot: snap, sources, byId, byPath };
}
function eagerClosure(snap, trustedRoots) {
  const index = buildSourceIndex(snap);
  const roots = [...new Set(trustedRoots.map((id) => nonEmpty(id, "trusted root")))].sort();
  const reachable = new Set();
  const whyRequirement = new Map();
  for (const root of roots) {
    if (!index.byId.has(root)) throw new Error('trusted root "' + root + '" is absent from exact snapshot');
    reachable.add(root);
    whyRequirement.set(root, [root]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const requirement of [...index.byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (reachable.has(requirement.id)) continue;
      const parents = requirement.relations
        .filter((relation) => relation.predicate === "derives_from" && relation.target.kind === "requirement")
        .map((relation) => relation.target.id)
        .sort();
      const parent = parents.find((id) => reachable.has(id));
      if (!parent) continue;
      reachable.add(requirement.id);
      whyRequirement.set(requirement.id, [...whyRequirement.get(parent), requirement.id]);
      changed = true;
    }
  }
  const orphanRequirements = [...index.byId.keys()].filter((id) => !reachable.has(id)).sort();
  const justifiedResources = new Set();
  const whyResource = new Map();
  // Canonical source representation is justified by semantic Requirement reachability.
  for (const id of [...reachable].sort()) {
    const requirement = index.byId.get(id);
    justifiedResources.add(requirement.source_path);
    whyResource.set(requirement.source_path, [...whyRequirement.get(id), "@source:" + requirement.source_path]);
    for (const relation of requirement.relations) {
      if (relation.target.kind !== "artifact") continue;
      justifiedResources.add(relation.target.path);
      const candidate = [...whyRequirement.get(id), relation.predicate + ":" + relation.target.path];
      const previous = whyResource.get(relation.target.path);
      if (!previous || stable(candidate) < stable(previous)) whyResource.set(relation.target.path, candidate);
    }
  }
  const orphanTrackedResources = snap.trackedFiles
    .filter((path) => !justifiedResources.has(path))
    .sort();
  return {
    ok: orphanRequirements.length === 0 && orphanTrackedResources.length === 0,
    index,
    trustedRoots: roots,
    reachableRequirements: [...reachable].sort(),
    justifiedResources: [...justifiedResources].sort(),
    orphanRequirements,
    orphanTrackedResources,
    explanations: {
      whyRequirement: Object.fromEntries([...whyRequirement.entries()].sort(([a], [b]) => a.localeCompare(b))),
      whyResource: Object.fromEntries([...whyResource.entries()].sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}
function compareSemanticRequirements(base, head) {
  const b = buildSourceIndex(base), h = buildSourceIndex(head);
  const ids = [...new Set([...b.byId.keys(), ...h.byId.keys()])].sort();
  const delta = { add: [], remove: [], modify: [], source_move: [] };
  for (const id of ids) {
    const before = b.byId.get(id), after = h.byId.get(id);
    if (!before) delta.add.push(id);
    else if (!after) delta.remove.push(id);
    else {
      if (before.semantic_sha256 !== after.semantic_sha256) delta.modify.push(id);
      if (before.source_path !== after.source_path) {
        delta.source_move.push({ id, from: before.source_path, to: after.source_path });
      }
    }
  }
  return delta;
}
function validateRequirementDeltaAuthority(base, head, authorizedIds = []) {
  const delta = compareSemanticRequirements(base, head);
  const protectedIds = new Set([...delta.add, ...delta.remove, ...delta.modify]);
  const authorized = new Set(authorizedIds);
  const missing = [...protectedIds].filter((id) => !authorized.has(id)).sort();
  return { ok: missing.length === 0, missing, delta };
}
function normalizeResourceRef(value) {
  const ref = object(value, "ResourceRef");
  if (ref.kind === "requirement") {
    exactFields(ref, ["kind", "id"], "RequirementRef");
    return { kind: "requirement", id: nonEmpty(ref.id, "RequirementRef.id") };
  }
  if (ref.kind === "artifact") {
    exactFields(ref, ["kind", "path"], "ArtifactRef");
    return { kind: "artifact", path: safePath(ref.path, "ArtifactRef.path") };
  }
  if (ref.kind === "document") {
    exactFields(ref, ["kind", "path", "pointer"], "DocumentRef");
    return { kind: "document", path: safePath(ref.path, "DocumentRef.path"), pointer: pointer(ref.pointer) };
  }
  if (ref.kind === "external_document") {
    exactFields(ref, ["kind", "repository", "revision", "path", "pointer"], "ExternalDocumentRef");
    return {
      kind: "external_document",
      repository: repositoryId(ref.repository, "ExternalDocumentRef.repository"),
      revision: exactRevision(ref.revision, "ExternalDocumentRef.revision"),
      path: safePath(ref.path, "ExternalDocumentRef.path"),
      pointer: pointer(ref.pointer),
    };
  }
  throw new Error('ResourceRef: unsupported kind "' + String(ref.kind) + '"');
}
function parseDocumentAt(snap, path) {
  const content = snap.files.get(path);
  if (content === undefined) throw new Error('missing exact document "' + path + '"');
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return strictCanonicalParse("yaml", content);
  if (path.endsWith(".json")) return strictCanonicalParse("json", content);
  return content;
}
function exactCoordinateKey(repository, revision, path, ptr = "") {
  return JSON.stringify([
    repositoryId(repository),
    exactRevision(revision),
    safePath(path),
    pointer(ptr),
  ]);
}
function createResolver({ localSnapshot, externalSnapshots = [], trustedResourcePaths = [] }) {
  const localIndex = buildSourceIndex(localSnapshot);
  const external = new Map();
  for (const snap of externalSnapshots) {
    const key = JSON.stringify([snap.repository, snap.revision]);
    if (external.has(key)) throw new Error("duplicate external exact snapshot");
    external.set(key, snap);
  }
  const trusted = new Set(trustedResourcePaths.map((path) => safePath(path, "trusted resource path")));
  const cache = new Map();
  const resolve = (rawRef) => {
    const ref = normalizeResourceRef(rawRef);
    if (ref.kind === "requirement") {
      const requirement = localIndex.byId.get(ref.id);
      if (!requirement) throw new Error('missing Requirement "' + ref.id + '"');
      return structuredClone({
        kind: "requirement",
        semantic_id: ref.id,
        semantic_sha256: requirement.semantic_sha256,
        representation: {
          repository: localSnapshot.repository,
          revision: localSnapshot.revision,
          path: requirement.source_path,
          pointer: "",
        },
      });
    }
    let snap = localSnapshot;
    let path = ref.path;
    let ptr = "";
    if (ref.kind === "external_document") {
      snap = external.get(JSON.stringify([ref.repository, ref.revision]));
      if (!snap) throw new Error("external exact snapshot unavailable");
      path = ref.path;
      ptr = ref.pointer;
    } else if (ref.kind === "document") {
      ptr = ref.pointer;
    }
    if (!snap.files.has(path)) throw new Error('missing exact resource "' + path + '"');
    const key = exactCoordinateKey(snap.repository, snap.revision, path, ptr);
    if (cache.has(key)) return structuredClone(cache.get(key));
    let selected = parseDocumentAt(snap, path);
    if (ptr !== "") selected = resolveJsonPointer(selected, ptr);
    const value = structuredClone(selected);
    const result = {
      kind: ref.kind,
      exact: {
        repository: snap.repository,
        revision: snap.revision,
        path,
        pointer: ptr,
      },
      trusted: trusted.has(path),
      value,
    };
    cache.set(key, result);
    return structuredClone(result);
  };
  return { resolve, localIndex, cache };
}
function pointerStability(ptr) {
  const normalized = pointer(ptr);
  if (normalized === "") return "stable-root";
  const segments = normalized.slice(1).split("/").map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((segment) => /^(?:0|[1-9]\d*)$/.test(segment))
    ? "positional-unsafe"
    : "stable-keyed";
}
function semanticSubject(index, id) {
  const requirement = index.byId.get(id);
  if (!requirement) throw new Error("missing semantic subject " + id);
  return {
    binding: "semantic_requirement",
    repository: index.snapshot.repository,
    requirement_id: id,
    semantic_sha256: requirement.semantic_sha256,
  };
}
function representationSubject(snap, path, ptr = "") {
  const selected = ptr === "" ? parseDocumentAt(snap, safePath(path)) : resolveJsonPointer(parseDocumentAt(snap, safePath(path)), pointer(ptr));
  return {
    binding: "exact_fragment",
    repository: snap.repository,
    revision: snap.revision,
    path: safePath(path),
    pointer: pointer(ptr),
    value_sha256: sha256(selected),
  };
}
function receiptMatches(receipt, subject) {
  return stable(receipt) === stable(subject);
}
function reverseImpactRequirements(index, artifactPath) {
  const path = safePath(artifactPath);
  const direct = new Set();
  for (const requirement of index.byId.values()) {
    if (requirement.relations.some((relation) => relation.target.kind === "artifact" && relation.target.path === path)) {
      direct.add(requirement.id);
    }
  }
  const impacted = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const requirement of index.byId.values()) {
      for (const relation of requirement.relations) {
        if (relation.target.kind !== "requirement") continue;
        if (!["derives_from", "depends_on", "constrains"].includes(relation.predicate)) continue;
        if (impacted.has(requirement.id) && !impacted.has(relation.target.id)) {
          impacted.add(relation.target.id); changed = true;
        }
        if (impacted.has(relation.target.id) && relation.predicate === "derives_from" && !impacted.has(requirement.id)) {
          impacted.add(requirement.id); changed = true;
        }
      }
    }
  }
  return [...impacted].sort().map((id) => ({ kind: "impact_candidate", requirement_id: id }));
}
function requirementYaml(id, relations = {}) {
  const relationLines = Object.entries(relations).flatMap(([key, relation]) => {
    const target = relation.target.kind === "requirement"
      ? ["      kind: requirement", "      id: " + relation.target.id]
      : ["      kind: artifact", "      path: " + JSON.stringify(relation.target.path)];
    return [
      "  " + key + ":",
      "    predicate: " + relation.predicate,
      "    target:",
      ...target,
    ];
  });
  return [
    "id: " + id,
    ...(relationLines.length ? ["relations:", ...relationLines] : []),
    "",
  ].join("\n");
}
export {
  graph700,
  req700,
  res700,
  rel700,
  wi700,
  receipt700,
  evaluate700,
  assert700,
  transitionDeltas700,
  validateHead700,
  j1Closure700,
  j2Closure700,
  reachableResourcesFromRequirement700,
  affectedRequirements700,
  snapshot,
  buildSourceIndex,
  eagerClosure,
  compareSemanticRequirements,
  validateRequirementDeltaAuthority,
  normalizeResourceRef,
  createResolver,
  pointerStability,
  semanticSubject,
  representationSubject,
  receiptMatches,
  reverseImpactRequirements,
  requirementYaml,
  strictCanonicalParse,
  exactCoordinateKey,
};
