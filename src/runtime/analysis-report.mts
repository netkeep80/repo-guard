const CHECK_FIELDS = new Set([
  "ok",
  "advisory",
  "message",
  "details",
  "errors",
  "hint",
  "rule",
  "severity",
  "data",
]);

type LooseObject = Record<string, unknown>;
type CheckInput = LooseObject & {
  ok?: unknown;
  advisory?: unknown;
  message?: unknown;
  details?: unknown;
  errors?: unknown;
  hint?: unknown;
  data?: unknown;
};
type Severity = "pass" | "warning" | "failure";
type Outcome = "pass" | "warning" | "violation";
interface NormalizedCheckResult {
  rule: string;
  ok: boolean;
  severity: Severity;
  details: string[];
  message?: unknown;
  hint?: unknown;
  data?: LooseObject;
}
interface AnalysisPresenter {
  check?: (event: { check: NormalizedCheckResult; mode: unknown; outcome: Outcome }) => void;
  finish?: (report: unknown) => void;
}
interface CollectorOptions {
  presenter?: AnalysisPresenter | null;
}
type EnforcementProjection = LooseObject & { mode?: unknown };

function isPlainObject(value: unknown): value is LooseObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function formatList(values: readonly unknown[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue).filter((item) => item !== undefined);
  if (!isPlainObject(value)) return value;

  const compacted: LooseObject = {};
  for (const [key, nested] of Object.entries(value)) {
    const clean = compactValue(nested);
    if (clean !== undefined) compacted[key] = clean;
  }
  return compacted;
}

function checkData(check: unknown): LooseObject {
  if (isPlainObject((check as CheckInput).data)) return (check as CheckInput).data as LooseObject;

  const data: LooseObject = {};
  for (const [key, value] of Object.entries((check as LooseObject) || {})) {
    if (CHECK_FIELDS.has(key) || value === undefined) continue;
    const compacted = compactValue(value);
    if (Array.isArray(compacted) && compacted.length === 0) continue;
    if (isPlainObject(compacted) && Object.keys(compacted).length === 0) continue;
    data[key] = compacted;
  }
  return data;
}

function dataDetails(data: LooseObject, { includeComplex }: { includeComplex: boolean }): string[] {
  const details: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (isScalar(value)) {
      details.push(`${key}: ${value}`);
    } else if (Array.isArray(value) && value.every(isScalar)) {
      if (value.length > 0) details.push(`${key}: ${formatList(value)}`);
    } else if (includeComplex && isPlainObject(value) && Object.values(value).every(isScalar)) {
      details.push(`${key}: ${JSON.stringify(value)}`);
    } else if (includeComplex && Array.isArray(value) && value.length > 0) {
      details.push(`${key}: ${value.length} item(s)`);
    }
  }
  return details;
}

function asList(value: unknown): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export function detailFromCheck(check: unknown): string[] {
  const explicitDetails = asList((check as CheckInput).details);
  const errors = asList((check as CheckInput).errors);
  const data = checkData(check);
  const includeComplex = explicitDetails.length === 0 && errors.length === 0;
  return [
    ...asList((check as CheckInput).message),
    ...dataDetails(data, { includeComplex }),
    ...explicitDetails,
    ...errors,
    ...asList((check as CheckInput).hint).map((hint) => `hint: ${hint}`),
  ];
}

function normalizeCheckResult(name: string, check: unknown): NormalizedCheckResult {
  const ok = Boolean((check as CheckInput).ok);
  const result: NormalizedCheckResult = {
    rule: name,
    ok,
    severity: ok ? "pass" : (check as CheckInput).advisory ? "warning" : "failure",
    details: detailFromCheck(check),
  };
  const data = checkData(check);

  if ((check as CheckInput).message) result.message = (check as CheckInput).message;
  if ((check as CheckInput).hint) result.hint = (check as CheckInput).hint;
  if (Object.keys(data).length > 0) result.data = data;
  return result;
}

function normalizeEnforcement(enforcement: unknown): EnforcementProjection {
  if (typeof enforcement === "string") return { mode: enforcement };
  return (enforcement as EnforcementProjection | null | undefined) || { mode: "blocking" };
}

export function createAnalysisCollector(enforcementInput: unknown, options: CollectorOptions = {}) {
  const enforcement = normalizeEnforcement(enforcementInput);
  const mode = enforcement.mode;
  const presenter = options.presenter || null;
  let passed = 0;
  let violations = 0;
  let warnings = 0;
  const ruleResults: NormalizedCheckResult[] = [];
  const violationDetails: NormalizedCheckResult[] = [];
  const warningDetails: NormalizedCheckResult[] = [];
  const hints: Array<{ rule: string; message: unknown }> = [];

  return {
    report(name: string, check: unknown) {
      const normalized = normalizeCheckResult(name, check);
      ruleResults.push(normalized);

      if ((check as CheckInput).ok) {
        passed++;
        presenter?.check?.({ check: normalized, mode, outcome: "pass" });
        return;
      }

      if ((check as CheckInput).advisory) {
        warnings++;
        warningDetails.push(normalized);
        if (normalized.hint) hints.push({ rule: name, message: normalized.hint });
        presenter?.check?.({ check: normalized, mode, outcome: "warning" });
        return;
      }

      violations++;
      violationDetails.push(normalized);
      if (normalized.hint) hints.push({ rule: name, message: normalized.hint });
      presenter?.check?.({ check: normalized, mode, outcome: "violation" });
    },

    finish(extra: LooseObject = {}) {
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
