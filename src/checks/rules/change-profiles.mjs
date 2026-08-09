import { classifyNewFiles, detectTouchedSurfaces } from "../../diff/classification.mjs";
import { formatList, uniqueSorted } from "../../utils/collections.mjs";
import { maxBound } from "../relation-kernel.mjs";

function budget(actual, max, files = undefined) {
  return max === undefined ? { ok: true } : { ok: maxBound(actual, max), actual, limit: max, ...(files ? { files } : {}) };
}
function profileBudgets(files, canonicalDocs, limits = {}) {
  const added = files.filter((file) => file.status === "added");
  const docs = added.filter((file) => /\.md$/i.test(file.path) && !canonicalDocs.includes(file.path));
  const net = files.reduce((sum, file) => sum + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0), 0);
  return {
    docs: budget(docs.length, limits.max_new_docs, docs.map((file) => file.path)),
    files: budget(added.length, limits.max_new_files, added.map((file) => file.path)),
    lines: budget(net, limits.max_net_added_lines),
  };
}

function checkProfileNewFiles(files, classes, rule, changeType, detected = null) {
  if (!rule) return { ok: true };
  detected ||= classifyNewFiles(files, classes || {});
  const newFiles = detected.new_files;
  if (!newFiles.length) return { ok: true, change_type: changeType, new_files: [], files_by_class: detected.files_by_class, unclassified_files: detected.unclassified_files };
  const allowedClasses = uniqueSorted(rule.allow_classes || []), allowed = new Set(allowedClasses);
  const touchedClasses = uniqueSorted(Object.keys(detected.files_by_class));
  const violatingClasses = allowedClasses.length ? touchedClasses.filter((name) => !allowed.has(name)) : touchedClasses;
  const unclassifiedFiles = detected.unclassified_files;
  const classBudgetViolations = Object.entries(rule.max_per_class || {}).flatMap(([fileClass, limit]) => {
    const selected = detected.files_by_class[fileClass] || [];
    return maxBound(selected.length, limit) ? [] : [{ class: fileClass, actual: selected.length, limit, files: selected }];
  });
  const exceedsMax = !maxBound(newFiles.length, rule.max_new_files);
  const details = [
    ...violatingClasses.map((name) => `class ${name} is not allowed by change_profiles["${changeType}"].new_files.allow_classes; files: ${detected.files_by_class[name].join(", ")}`),
    ...unclassifiedFiles.map((file) => `file ${file} detected class: unclassified; violated rule: change_profiles["${changeType}"].new_files.allow_classes`),
    ...classBudgetViolations.map((v) => `class ${v.class} has ${v.actual} new file(s), limit ${v.limit}; files: ${v.files.join(", ")}`),
  ];
  if (exceedsMax) details.push(`new files ${newFiles.length} exceeds change_profiles["${changeType}"].new_files.max_new_files ${rule.max_new_files}`);
  const ok = !violatingClasses.length && !unclassifiedFiles.length && !classBudgetViolations.length && !exceedsMax;
  return {
    ok, message: violatingClasses.length ? `change_type "${changeType}" cannot add new-file classes: ${violatingClasses.join(", ")}`
      : unclassifiedFiles.length ? `change_profiles["${changeType}"].new_files found added files that match no declared new_file_class: ${unclassifiedFiles.join(", ")}`
        : !ok ? `change_type "${changeType}" exceeds change_profiles["${changeType}"].new_files budget` : undefined,
    change_type: changeType, new_files: newFiles, actual: exceedsMax ? newFiles.length : undefined, limit: exceedsMax ? rule.max_new_files : undefined,
    allowed_classes: allowedClasses, touched_classes: touchedClasses, violating_classes: violatingClasses, class_budget_violations: classBudgetViolations,
    files_by_class: detected.files_by_class, unclassified_files: unclassifiedFiles, details,
    hint: unclassifiedFiles.length ? "Add matching new_file_classes globs or update the change_profile.new_files.allow_classes." : undefined,
  };
}

export function checkChangeProfile(files, policy, changeType, derived = {}) {
  const profiles = policy.change_profiles || {};
  if (!Object.keys(profiles).length) return { ok: true };
  if (!changeType) return { ok: false, message: "change_profiles requires a declared change_type", change_type: null, hint: "Set change_type in the contract." };
  const profile = profiles[changeType];
  if (!profile) return { ok: false, message: `change_type "${changeType}" is not defined in change_profiles`, change_type: changeType, details: [`known change types: ${formatList(Object.keys(profiles).sort())}`], hint: "Define the change type in change_profiles or use one of the configured types." };

  const detected = derived.touchedSurfaces || detectTouchedSurfaces(files, policy.surfaces);
  const touched = detected.touched_surfaces, required = uniqueSorted(profile.require_surfaces || []), allowed = uniqueSorted(profile.allow_surfaces || []), forbidden = uniqueSorted(profile.forbid_surfaces || []);
  const touchedSet = new Set(touched), usesConstraints = required.length + allowed.length + forbidden.length > 0;
  const hasUnclassified = usesConstraints && detected.unclassified_files.length > 0 && !profile.allow_unclassified_surfaces;
  const missing = required.filter((surface) => !touchedSet.has(surface));
  const violating = uniqueSorted([...(allowed.length ? touched.filter((surface) => !allowed.includes(surface)) : []), ...touched.filter((surface) => forbidden.includes(surface))]);
  const newFiles = checkProfileNewFiles(files, policy.new_file_classes, profile.new_files, changeType, derived.newFileClasses);
  const budgets = profileBudgets(files, policy.paths.canonical_docs, profile.budgets);
  const details = [
    ...missing.map((surface) => `required surface ${surface} was not touched by change_profiles["${changeType}"].require_surfaces`),
    ...violating.map((surface) => `surface ${surface} violated change_profiles["${changeType}"] surface constraints; files: ${detected.files_by_surface[surface].join(", ")}`),
  ];
  if (hasUnclassified) details.push(`changed files matched no declared surface: ${detected.unclassified_files.join(", ")}`);
  if (!budgets.docs.ok) details.push(`new docs ${budgets.docs.actual} exceeds change_profiles["${changeType}"].budgets.max_new_docs ${budgets.docs.limit}; files: ${budgets.docs.files.join(", ")}`);
  if (!budgets.files.ok) details.push(`new files ${budgets.files.actual} exceeds change_profiles["${changeType}"].budgets.max_new_files ${budgets.files.limit}; files: ${budgets.files.files.join(", ")}`);
  if (!budgets.lines.ok) details.push(`net added lines ${budgets.lines.actual} exceeds change_profiles["${changeType}"].budgets.max_net_added_lines ${budgets.lines.limit}`);
  if (!newFiles.ok) details.push(...(newFiles.details || [newFiles.message]).filter(Boolean));
  const ok = !missing.length && !violating.length && !hasUnclassified && budgets.docs.ok && budgets.files.ok && budgets.lines.ok && newFiles.ok;
  return {
    ok, message: ok ? undefined : `change_type "${changeType}" violated change_profiles`, change_type: changeType,
    touched_surfaces: touched, required_surfaces: required, allowed_surfaces: allowed, forbidden_surfaces: forbidden,
    missing_required_surfaces: missing, violating_surfaces: violating, files_by_surface: detected.files_by_surface, unclassified_files: detected.unclassified_files,
    docs_budget: budgets.docs, new_files_budget: budgets.files, net_added_lines_budget: budgets.lines, new_files: newFiles, details,
    hint: hasUnclassified ? "Add matching surface globs or set change_profiles[change_type].allow_unclassified_surfaces: true." : undefined,
  };
}
