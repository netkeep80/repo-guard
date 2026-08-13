import { uniqueSorted } from "../utils/collections.mjs";
import { matchesAny } from "../utils/path-patterns.mjs";
import { compareSets, implies } from "./relation-kernel.mjs";

const CHANGE_INTENT_ANCHOR_FIELDS = new Map([
  ["anchors.affects", ["anchors", "affects"]], ["anchors.implements", ["anchors", "implements"]], ["anchors.verifies", ["anchors", "verifies"]],
]);
const location = (instance) => `${instance.file}${instance.line ? `:${instance.line}` : ""}${instance.column ? `:${instance.column}` : ""}`;
function group(instances = []) {
  const grouped = new Map();
  for (const instance of instances) (grouped.get(instance.value) || grouped.set(instance.value, []).get(instance.value)).push({ ...instance });
  return grouped;
}
const changedPaths = (facts) => (facts.diff?.files?.checked || []).map((file) => file.path);
const matchingPaths = (paths, patterns) => uniqueSorted(paths.filter((path) => matchesAny(path, patterns || [])));
function changeIntentValues(changeIntent, field) {
  const path = CHANGE_INTENT_ANCHOR_FIELDS.get(field);
  if (!path) return [];
  let value = changeIntent || {};
  for (const segment of path) value = value?.[segment];
  return Array.isArray(value) ? uniqueSorted(value.map(String)) : [];
}

function mustResolve(rule, anchors) {
  const fromInstances = anchors.byType?.[rule.from_anchor_type] || [], toInstances = anchors.byType?.[rule.to_anchor_type] || [];
  const from = group(fromInstances), to = group(toInstances), values = [...from.keys()].sort();
  const relation = compareSets(values, [...to.keys()], "left_subset");
  const unresolved = relation.missing.map((value) => ({ value, instances: from.get(value) }));
  const resolved = values.filter((value) => !relation.missing.includes(value)).map((value) => ({ value, from: from.get(value), to: to.get(value) || [] }));
  return { id: rule.id, kind: rule.kind, fromAnchorType: rule.from_anchor_type, toAnchorType: rule.to_anchor_type, ok: relation.ok, resolved, unresolved,
    stats: { fromInstances: fromInstances.length, fromValues: from.size, toInstances: toInstances.length, toValues: to.size, resolved: resolved.length, unresolved: unresolved.length } };
}
function evidence(rule, facts, declared = null) {
  const paths = changedPaths(facts), evidenceFiles = matchingPaths(paths, rule.must_touch_any);
  const trigger = declared ?? matchingPaths(paths, rule.if_changed);
  const common = { id: rule.id, kind: rule.kind, ok: implies(trigger.length, evidenceFiles.length), mustTouchAny: [...(rule.must_touch_any || [])], evidenceFiles };
  return declared === null
    ? { ...common, ifChanged: [...(rule.if_changed || [])], changedFiles: trigger, stats: { changedFiles: trigger.length, evidenceFiles: evidenceFiles.length } }
    : { ...common, changeIntentField: rule.change_intent_field, declaredAnchors: trigger, stats: { declaredAnchors: trigger.length, evidenceFiles: evidenceFiles.length } };
}

export function buildTraceRuleDiagnostics(facts) {
  return (facts.policy.trace_rules || []).map((rule) => {
    if (rule.kind === "must_resolve") return mustResolve(rule, facts.anchors || {});
    if (rule.kind === "changed_files_require_evidence") return evidence(rule, facts);
    if (rule.kind === "declared_anchors_require_evidence") return evidence(rule, facts, changeIntentValues(facts.changeIntent, rule.change_intent_field));
    return { id: rule.id, kind: rule.kind, ok: true, stats: {} };
  });
}

function checkMustResolve(result) {
  const unresolved = (result.unresolved || []).map((item) => ({
    value: item.value, fromAnchorType: result.fromAnchorType, toAnchorType: result.toAnchorType,
    locations: (item.instances || []).map(location), instances: item.instances || [],
  }));
  return {
    ok: !unresolved.length, message: unresolved.length ? `unresolved anchor reference(s) for trace rule "${result.id}"` : undefined,
    trace_rule: result.id, trace_kind: result.kind, from_anchor_type: result.fromAnchorType, to_anchor_type: result.toAnchorType,
    unresolved_anchors: unresolved, files: uniqueSorted(unresolved.flatMap((anchor) => anchor.instances.map((instance) => instance.file))),
    details: unresolved.flatMap((anchor) => anchor.locations.map((where) => `${anchor.value} (${anchor.fromAnchorType} -> ${anchor.toAnchorType}) at ${where}`)),
  };
}
function checkEvidence(result) {
  const details = [];
  if (result.changedFiles) details.push(`changed_files: ${result.changedFiles.join(", ")}`);
  if (result.changeIntentField) details.push(`change_intent_field: ${result.changeIntentField}`);
  if (result.declaredAnchors) details.push(`declared_anchors: ${result.declaredAnchors.join(", ")}`);
  details.push(`must_touch_any: ${result.mustTouchAny.join(", ")}`, `evidence_files: ${result.evidenceFiles.length ? result.evidenceFiles.join(", ") : "(none)"}`);
  return { ok: result.ok, message: result.ok ? undefined : `missing evidence for trace rule "${result.id}"`, trace_rule: result.id, trace_kind: result.kind,
    if_changed: result.ifChanged, must_touch_any: result.mustTouchAny, changed_files: result.changedFiles, change_intent_field: result.changeIntentField,
    declared_anchors: result.declaredAnchors, evidence_files: result.evidenceFiles, files: uniqueSorted([...(result.changedFiles || []), ...(result.evidenceFiles || [])]), details };
}
export function checkTraceRuleResult(result) {
  if (result.kind === "must_resolve") return checkMustResolve(result);
  if (["changed_files_require_evidence", "declared_anchors_require_evidence"].includes(result.kind)) return checkEvidence(result);
  return { ok: true, trace_rule: result.id, trace_kind: result.kind, details: [] };
}
