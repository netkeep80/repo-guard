function formatList(values) {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function detailFromCheck(check) {
  const details = [];
  if (check.message) details.push(check.message);
  if (check.actual !== undefined) details.push(`actual: ${check.actual}, limit: ${check.limit}`);
  if (check.status) details.push(`status: ${check.status}`);
  if (check.growth) {
    details.push(`growth: new_files=${check.growth.new_files}, net_added_lines=${check.growth.net_added_lines}`);
  }
  if (check.files) details.push(...check.files.map((f) => `file: ${f}`));
  if (check.touched) details.push(...check.touched.map((f) => `touched: ${f}`));
  if (check.must_touch) details.push(`must_touch: ${check.must_touch.join(", ")}`);
  if (check.must_not_touch) details.push(`must_not_touch: ${check.must_not_touch.join(", ")}`);
  if (check.if_changed) details.push(`if_changed: ${formatList(check.if_changed)}`);
  if (check.must_touch_any) details.push(`must_touch_any: ${formatList(check.must_touch_any)}`);
  if (check.changed_files) details.push(`changed_files: ${formatList(check.changed_files)}`);
  if (check.evidence_files) details.push(`evidence_files: ${formatList(check.evidence_files)}`);
  if (check.contract_field) details.push(`contract_field: ${check.contract_field}`);
  if (check.declared_anchors) details.push(`declared_anchors: ${formatList(check.declared_anchors)}`);
  if (hasOwn(check, "change_class")) details.push(`change_class: ${check.change_class || "(missing)"}`);
  if (hasOwn(check, "change_type")) details.push(`change_type: ${check.change_type || "(missing)"}`);
  if (check.touched_surfaces) details.push(`touched_surfaces: ${formatList(check.touched_surfaces)}`);
  if (check.new_files) details.push(`new_files: ${formatList(check.new_files)}`);
  if (check.allowed_classes) details.push(`allowed_classes: ${formatList(check.allowed_classes)}`);
  if (check.touched_classes) details.push(`touched_classes: ${formatList(check.touched_classes)}`);
  if (check.violating_classes) details.push(`violating_classes: ${formatList(check.violating_classes)}`);
  if (check.allowed_surfaces) details.push(`allowed_surfaces: ${formatList(check.allowed_surfaces)}`);
  if (check.forbidden_surfaces) details.push(`forbidden_surfaces: ${formatList(check.forbidden_surfaces)}`);
  if (check.violating_surfaces) details.push(`violating_surfaces: ${formatList(check.violating_surfaces)}`);
  if (check.failed_rules) details.push(`failed_rules: ${formatList(check.failed_rules)}`);
  if (check.size_violations && (!check.details || check.details.length === 0)) {
    details.push(...check.size_violations.map((v) => `[${v.ruleId}] ${v.path} has ${v.actual} ${v.metric} (max ${v.max})`));
  }
  if (check.matches) {
    details.push(...check.matches.map((match) => {
      const sections = match.duplicate_section_titles && match.duplicate_section_titles.length > 0
        ? `, duplicate_sections=${formatList(match.duplicate_section_titles)}`
        : "";
      return `match: ${match.changed_file} -> ${match.canonical_file}, score=${match.score}, threshold=${match.threshold}${sections}`;
    }));
  }
  if (check.unclassified_files && check.unclassified_files.length > 0) {
    details.push(`unclassified_files: ${formatList(check.unclassified_files)}`);
  }
  if (check.class_budget_violations && check.class_budget_violations.length > 0) {
    details.push(...check.class_budget_violations.map(
      (v) => `class_budget: ${v.class} actual=${v.actual}, limit=${v.limit}, files=${formatList(v.files)}`
    ));
  }
  if (check.details) details.push(...check.details);
  if (check.errors) details.push(...check.errors);
  if (check.hint) details.push(`hint: ${check.hint}`);
  return details;
}

function violationFromCheck(name, check) {
  const violation = {
    rule: name,
    message: check.message,
    actual: check.actual,
    limit: check.limit,
    files: check.files || [],
    touched: check.touched || [],
    must_touch: check.must_touch || [],
    must_not_touch: check.must_not_touch || [],
    details: check.details || [],
    errors: check.errors || [],
    hint: check.hint,
  };

  if (check.if_changed) violation.if_changed = check.if_changed;
  if (check.must_touch_any) violation.must_touch_any = check.must_touch_any;
  if (check.changed_files) violation.changed_files = check.changed_files;
  if (check.evidence_files) violation.evidence_files = check.evidence_files;
  if (check.contract_field) violation.contract_field = check.contract_field;
  if (check.declared_anchors) violation.declared_anchors = check.declared_anchors;
  if (check.status) violation.status = check.status;
  if (check.growth) violation.growth = check.growth;
  if (check.surface_debt) violation.surface_debt = check.surface_debt;
  if (hasOwn(check, "change_class")) violation.change_class = check.change_class;
  if (hasOwn(check, "change_type")) violation.change_type = check.change_type;
  if (check.touched_surfaces) violation.touched_surfaces = check.touched_surfaces;
  if (check.new_files) violation.new_files = check.new_files;
  if (check.allowed_classes) violation.allowed_classes = check.allowed_classes;
  if (check.touched_classes) violation.touched_classes = check.touched_classes;
  if (check.violating_classes) violation.violating_classes = check.violating_classes;
  if (check.class_budget_violations) violation.class_budget_violations = check.class_budget_violations;
  if (check.files_by_class) violation.files_by_class = check.files_by_class;
  if (check.allowed_surfaces) violation.allowed_surfaces = check.allowed_surfaces;
  if (check.forbidden_surfaces) violation.forbidden_surfaces = check.forbidden_surfaces;
  if (check.violating_surfaces) violation.violating_surfaces = check.violating_surfaces;
  if (check.files_by_surface) violation.files_by_surface = check.files_by_surface;
  if (check.failed_rules) violation.failed_rules = check.failed_rules;
  if (check.size_violations) violation.size_violations = check.size_violations;
  if (check.results) violation.results = check.results;
  if (check.matches) violation.matches = check.matches;
  if (check.trace_rule) violation.trace_rule = check.trace_rule;
  if (check.trace_kind) violation.trace_kind = check.trace_kind;
  if (check.from_anchor_type) violation.from_anchor_type = check.from_anchor_type;
  if (check.to_anchor_type) violation.to_anchor_type = check.to_anchor_type;
  if (check.unresolved_anchors) violation.unresolved_anchors = check.unresolved_anchors;
  if (check.advisory) violation.advisory = true;
  if (check.unclassified_files && check.unclassified_files.length > 0) {
    violation.unclassified_files = check.unclassified_files;
  }

  return violation;
}

function normalizeEnforcement(enforcement) {
  if (typeof enforcement === "string") return { mode: enforcement };
  return enforcement || { mode: "blocking" };
}

export function createAnalysisCollector(enforcementInput, options = {}) {
  const enforcement = normalizeEnforcement(enforcementInput);
  const mode = enforcement.mode;
  const presenter = options.presenter || null;
  let passed = 0;
  let violations = 0;
  let warnings = 0;
  const ruleResults = [];
  const violationDetails = [];
  const warningDetails = [];
  const hints = [];

  return {
    report(name, check) {
      const normalized = { rule: name, ok: Boolean(check.ok), details: detailFromCheck(check) };
      ruleResults.push(normalized);

      if (check.ok) {
        passed++;
        presenter?.check?.({ name, check, mode, outcome: "pass" });
        return;
      }

      if (check.advisory) {
        warnings++;
        const warning = violationFromCheck(name, check);
        warning.advisory = true;
        warningDetails.push(warning);
        if (check.hint) hints.push({ rule: name, message: check.hint });
        presenter?.check?.({ name, check, mode, outcome: "warning" });
        return;
      }

      violations++;
      const violation = violationFromCheck(name, check);
      violationDetails.push(violation);
      if (check.hint) hints.push({ rule: name, message: check.hint });
      presenter?.check?.({ name, check, mode, outcome: "violation" });
    },

    finish(extra = {}) {
      const enforcedFailures = mode === "blocking" ? violations : 0;
      const exitCode = enforcedFailures > 0 ? 1 : 0;
      const result = violations > 0 ? "failed" : warnings > 0 ? "passed_with_warnings" : "passed";
      const report = {
        command: extra.command || null,
        mode,
        ok: violations === 0,
        result,
        passed,
        violations: violationDetails,
        advisoryWarnings: warningDetails,
        warnings,
        violationCount: violations,
        failed: enforcedFailures,
        exitCode,
        ruleResults,
        hints,
        ...extra,
      };

      presenter?.finish?.(report);
      return report;
    },

    get violations() {
      return violations;
    },
  };
}
