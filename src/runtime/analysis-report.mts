const CHECK_FIELDS = new Set(["ok", "advisory", "message", "details", "errors", "hint", "rule", "severity", "data"]);
type LooseObject = Record<string, unknown>;
type CheckInput = LooseObject & { ok?: unknown; advisory?: unknown; message?: unknown; details?: unknown; errors?: unknown; hint?: unknown; data?: unknown };
type Severity = "pass" | "warning" | "failure";
type Outcome = "pass" | "warning" | "violation";
interface NormalizedCheckResult { rule: string; ok: boolean; severity: Severity; details: string[]; message?: unknown; hint?: unknown; data?: LooseObject; evidence?: LooseObject; }
interface AnalysisPresenter { check?: (event: { check: NormalizedCheckResult; mode: unknown; outcome: Outcome }) => void; finish?: (report: unknown) => void; }
interface CollectorOptions { presenter?: AnalysisPresenter | null; }
type EnforcementProjection = LooseObject & { mode?: unknown };
type ReportEvidence = LooseObject & { enforcementMode?: unknown };

const plain = (value: unknown): value is LooseObject => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
const list = (value: unknown): string[] => !value ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, compact(nested)]).filter(([, nested]) => nested !== undefined));
}
function checkData(check: unknown): LooseObject {
  if (plain((check as CheckInput).data)) return (check as CheckInput).data as LooseObject;
  return Object.fromEntries(Object.entries((check as LooseObject) || {}).flatMap(([key, value]) => {
    if (CHECK_FIELDS.has(key) || value === undefined) return [];
    const clean = compact(value);
    if ((Array.isArray(clean) && !clean.length) || (plain(clean) && !Object.keys(clean).length)) return [];
    return [[key, clean]];
  }));
}
function dataDetails(data: LooseObject, includeComplex: boolean): string[] {
  return Object.entries(data).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    if (scalar(value)) return [`${key}: ${value}`];
    if (Array.isArray(value) && value.every(scalar)) return value.length ? [`${key}: ${value.join(", ")}`] : [];
    if (includeComplex && plain(value) && Object.values(value).every(scalar)) return [`${key}: ${JSON.stringify(value)}`];
    return includeComplex && Array.isArray(value) && value.length ? [`${key}: ${value.length} item(s)`] : [];
  });
}
export function detailFromCheck(check: unknown): string[] {
  const details = list((check as CheckInput).details), errors = list((check as CheckInput).errors), data = checkData(check);
  return [...list((check as CheckInput).message), ...dataDetails(data, !details.length && !errors.length), ...details, ...errors, ...list((check as CheckInput).hint).map((hint) => `hint: ${hint}`)];
}
function normalizeCheckResult(name: string, check: unknown, evidence: ReportEvidence): NormalizedCheckResult {
  const ok = Boolean((check as CheckInput).ok), severity: Severity = ok ? "pass" : (check as CheckInput).advisory ? "warning" : "failure", data = checkData(check);
  const { enforcementMode: _enforcementMode, ...publicEvidence } = evidence;
  const result: NormalizedCheckResult = { rule: name, ok, severity, details: detailFromCheck(check), evidence: { ruleId: name, ...publicEvidence, ...(typeof data.kind === "string" ? { relation: data.kind } : {}), ok, reasonCode: `${name}.${severity}` } };
  if ((check as CheckInput).message) result.message = (check as CheckInput).message;
  if ((check as CheckInput).hint) result.hint = (check as CheckInput).hint;
  if (Object.keys(data).length) result.data = data;
  return result;
}
const enforcement = (value: unknown): EnforcementProjection => typeof value === "string" ? { mode: value } : (value as EnforcementProjection | null | undefined) || { mode: "blocking" };

export function createAnalysisCollector(enforcementInput: unknown, options: CollectorOptions = {}) {
  const mode = enforcement(enforcementInput).mode, presenter = options.presenter || null;
  let passed = 0, violations = 0, warnings = 0, enforcedFailures = 0;
  const ruleResults: NormalizedCheckResult[] = [], violationDetails: NormalizedCheckResult[] = [], warningDetails: NormalizedCheckResult[] = [], hints: Array<{ rule: string; message: unknown }> = [];
  return {
    report(name: string, check: unknown, evidence: ReportEvidence = {}) {
      const effectiveMode = evidence.enforcementMode ?? mode, normalized = normalizeCheckResult(name, check, evidence);
      ruleResults.push(normalized);
      if ((check as CheckInput).ok) { passed++; presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "pass" }); return; }
      if ((check as CheckInput).advisory) { warnings++; warningDetails.push(normalized); if (normalized.hint) hints.push({ rule: name, message: normalized.hint }); presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "warning" }); return; }
      violations++; if (effectiveMode === "blocking") enforcedFailures++;
      violationDetails.push(normalized); if (normalized.hint) hints.push({ rule: name, message: normalized.hint }); presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "violation" });
    },
    finish(extra: LooseObject = {}) {
      const exitCode = enforcedFailures ? 1 : 0, result = violations ? "failed" : warnings ? "passed_with_warnings" : "passed";
      const report = { command: extra.command || null, mode, ok: violations === 0, result, passed, violations: violationDetails, advisoryWarnings: warningDetails, warnings, violationCount: violations, failed: enforcedFailures, exitCode, ruleResults, hints, ...extra };
      presenter?.finish?.(report); return report;
    },
    get violations() { return violations; },
  };
}
