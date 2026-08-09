import { calculateDiffGrowth } from "../../diff/growth.mjs";
import { selectPaths } from "../../diff/classification.mjs";
import { matchesAny } from "../../utils/path-patterns.mjs";

function budget(selected, max) {
  if (max === undefined) return { ok: true };
  return { ok: selected.length <= max, actual: selected.length, limit: max, files: selected.map((file) => file.path) };
}

export function checkCanonicalDocsBudget(files, canonicalDocs = [], max) {
  return budget(files.filter((file) => file.status === "added" && /\.md$/i.test(file.path) && !canonicalDocs.includes(file.path)), max);
}

export function checkNewFilesBudget(files, max) {
  return budget(files.filter((file) => file.status === "added"), max);
}

export function checkNetAddedLinesBudget(files, max) {
  if (max === undefined) return { ok: true };
  const actual = files.reduce((sum, file) => sum + (file.addedLines?.length || 0) - (file.deletedLines?.length || 0), 0);
  return { ok: actual <= max, actual, limit: max };
}

export function checkSurfaceDebt(files, debt) {
  const growth = calculateDiffGrowth(files);
  if (growth.new_files <= 0 && growth.net_added_lines <= 0) return { ok: true, status: "not_needed", growth };
  if (!debt) return { ok: true, status: "undeclared", growth, details: [`new files: ${growth.new_files}`, `net added lines: ${growth.net_added_lines}`] };
  if (!debt.repayment_issue) return {
    ok: false, status: "missing_repayment_target", message: "declared surface debt is missing repayment target: repayment_issue",
    growth, surface_debt: debt, details: ["missing repayment_issue"],
    hint: "Set repayment_issue to the issue number where the temporary growth will be repaid.",
  };
  const expected = debt.expected_delta || {};
  const exceeded = [];
  if (expected.max_new_files !== undefined && growth.new_files > expected.max_new_files) exceeded.push(`new files ${growth.new_files} exceeds declared debt ${expected.max_new_files}`);
  if (expected.max_net_added_lines !== undefined && growth.net_added_lines > expected.max_net_added_lines) exceeded.push(`net added lines ${growth.net_added_lines} exceeds declared debt ${expected.max_net_added_lines}`);
  return {
    ok: exceeded.length === 0, status: exceeded.length ? "declared_debt_exceeded" : "declared",
    message: exceeded.length ? "declared surface debt is smaller than actual diff growth" : undefined,
    growth, surface_debt: debt, details: exceeded,
    hint: exceeded.length ? "Update expected_delta to match intentional temporary growth or reduce the diff." : undefined,
  };
}

export const checkForbiddenPaths = (files, patterns) => selectPaths(files, patterns, { excludeStatuses: ["deleted"] });

export function checkScope(files, patterns) {
  if (!patterns?.length) return { ok: true };
  const out = files.filter((file) => !matchesAny(file.path, patterns)).map((file) => file.path).sort();
  return {
    ok: out.length === 0, declared_scope: patterns, out_of_scope_paths: out,
    message: out.length ? "changed files fall outside declared contract scope" : undefined,
    details: out.map((path) => `out of scope: ${path}`),
  };
}

export function checkMustTouch(files, patterns) {
  if (!patterns?.length) return { ok: true };
  const satisfied = selectPaths(files, patterns).length > 0;
  return {
    ok: satisfied, must_touch: patterns, changed: files.map((file) => file.path),
    hint: satisfied ? undefined : "must_touch uses any-of semantics: at least one pattern must match a changed file",
  };
}

export function checkMustNotTouch(files, patterns) {
  if (!patterns?.length) return { ok: true };
  const touched = selectPaths(files, patterns);
  return { ok: touched.length === 0, touched, must_not_touch: patterns };
}

export function checkCochangeRules(files, rules = []) {
  return rules.flatMap((rule) => selectPaths(files, rule.if_changed).length && !selectPaths(files, rule.must_change_any).length
    ? [{ if_changed: rule.if_changed, must_change_any: rule.must_change_any }] : []);
}

export function compileConstraintIR(facts) {
  const diff = facts.policy.diff_rules || {};
  const budgets = facts.contract?.budgets || {};
  const constraints = [
    { kind: "forbid_paths", name: "forbidden-paths", patterns: facts.policy.paths.forbidden },
    { kind: "max_metric", name: "canonical-docs-budget", metric: "new_docs", max: budgets.max_new_docs ?? diff.max_new_docs },
    { kind: "max_metric", name: "max-new-files", metric: "new_files", max: budgets.max_new_files ?? diff.max_new_files },
    { kind: "max_metric", name: "max-net-added-lines", metric: "net_added_lines", max: budgets.max_net_added_lines ?? diff.max_net_added_lines },
    { kind: "surface_debt", name: "surface-debt", debt: facts.contract?.surface_debt },
    ...facts.policy.cochange_rules.map((rule) => ({ kind: "implies_nonempty", name: "cochange", ...rule })),
  ];
  if (facts.contract) constraints.push(
    { kind: "scope_paths", name: "contract-scope", patterns: facts.contract.scope },
    { kind: "require_paths", name: "must-touch", patterns: facts.contract.must_touch },
    { kind: "forbid_paths", name: "must-not-touch", patterns: facts.contract.must_not_touch, contract: true },
  );
  return { files: facts.diff.files.checked, constraints };
}

function evaluateMetric(files, constraint, policy) {
  if (constraint.metric === "new_docs") return checkCanonicalDocsBudget(files, policy.paths.canonical_docs, constraint.max);
  if (constraint.metric === "new_files") return checkNewFilesBudget(files, constraint.max);
  return checkNetAddedLinesBudget(files, constraint.max);
}

export function evaluateConstraintIR(facts) {
  const { files, constraints } = compileConstraintIR(facts);
  const results = [], cochange = [];
  for (const constraint of constraints) {
    let check;
    if (constraint.kind === "max_metric") check = evaluateMetric(files, constraint, facts.policy);
    else if (constraint.kind === "surface_debt") check = checkSurfaceDebt(files, constraint.debt);
    else if (constraint.kind === "scope_paths") check = checkScope(files, constraint.patterns);
    else if (constraint.kind === "require_paths") check = checkMustTouch(files, constraint.patterns);
    else if (constraint.kind === "forbid_paths") {
      if (constraint.contract) check = checkMustNotTouch(files, constraint.patterns);
      else {
        const found = checkForbiddenPaths(files, constraint.patterns);
        check = { ok: found.length === 0, files: found };
      }
    } else if (constraint.kind === "implies_nonempty") {
      if (selectPaths(files, constraint.if_changed).length && !selectPaths(files, constraint.must_change_any).length) cochange.push(constraint);
      continue;
    }
    results.push({ name: constraint.name, check });
  }
  results.push(...(cochange.length
    ? cochange.map((item) => ({ name: `cochange: ${item.if_changed.join(",")} -> ${item.must_change_any.join(",")}`, check: { ok: false, must_touch: item.must_change_any } }))
    : [{ name: "cochange-rules", check: { ok: true } }]));
  return results;
}

export const constraintRuleFamily = { id: "constraints", evaluate: evaluateConstraintIR };
