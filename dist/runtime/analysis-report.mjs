const CHECK_FIELDS = new Set(["ok", "advisory", "message", "details", "errors", "hint", "rule", "severity", "data"]);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const list = (value) => !value ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
function compact(value) {
    if (Array.isArray(value))
        return value.map(compact).filter((item) => item !== undefined);
    if (!plain(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, compact(nested)]).filter(([, nested]) => nested !== undefined));
}
function checkData(check) {
    if (plain(check.data))
        return check.data;
    return Object.fromEntries(Object.entries(check || {}).flatMap(([key, value]) => {
        if (CHECK_FIELDS.has(key) || value === undefined)
            return [];
        const clean = compact(value);
        if ((Array.isArray(clean) && !clean.length) || (plain(clean) && !Object.keys(clean).length))
            return [];
        return [[key, clean]];
    }));
}
function dataDetails(data, includeComplex) {
    return Object.entries(data).flatMap(([key, value]) => {
        if (value === undefined || value === null)
            return [];
        if (scalar(value))
            return [`${key}: ${value}`];
        if (Array.isArray(value) && value.every(scalar))
            return value.length ? [`${key}: ${value.join(", ")}`] : [];
        if (includeComplex && plain(value) && Object.values(value).every(scalar))
            return [`${key}: ${JSON.stringify(value)}`];
        return includeComplex && Array.isArray(value) && value.length ? [`${key}: ${value.length} item(s)`] : [];
    });
}
export function detailFromCheck(check) {
    const details = list(check.details), errors = list(check.errors), data = checkData(check);
    return [...list(check.message), ...dataDetails(data, !details.length && !errors.length), ...details, ...errors, ...list(check.hint).map((hint) => `hint: ${hint}`)];
}
function normalizeCheckResult(name, check, evidence) {
    const ok = Boolean(check.ok), severity = ok ? "pass" : check.advisory ? "warning" : "failure", data = checkData(check);
    const { enforcementMode: _enforcementMode, ...publicEvidence } = evidence;
    const relationId = typeof data.relation_id === "string" ? data.relation_id : name, operands = plain(data.operands) ? data.operands : undefined;
    const result = { rule: name, ok, severity, details: detailFromCheck(check), evidence: { ...publicEvidence, ruleId: relationId, ...(typeof data.kind === "string" ? { relation: data.kind } : {}), ...(operands ? { operands } : {}), ok, reasonCode: `${relationId}.${severity}` } };
    if (check.message)
        result.message = check.message;
    if (check.hint)
        result.hint = check.hint;
    if (Object.keys(data).length)
        result.data = data;
    return result;
}
const enforcement = (value) => typeof value === "string" ? { mode: value } : value || { mode: "blocking" };
export function createAnalysisCollector(enforcementInput, options = {}) {
    const mode = enforcement(enforcementInput).mode, presenter = options.presenter || null;
    let passed = 0, violations = 0, warnings = 0, enforcedFailures = 0;
    const ruleResults = [], violationDetails = [], warningDetails = [], hints = [];
    return {
        report(name, check, evidence = {}) {
            const effectiveMode = evidence.enforcementMode ?? mode, normalized = normalizeCheckResult(name, check, evidence);
            ruleResults.push(normalized);
            if (check.ok) {
                passed++;
                presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "pass" });
                return;
            }
            if (check.advisory) {
                warnings++;
                warningDetails.push(normalized);
                if (normalized.hint)
                    hints.push({ rule: name, message: normalized.hint });
                presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "warning" });
                return;
            }
            violations++;
            if (effectiveMode === "blocking")
                enforcedFailures++;
            violationDetails.push(normalized);
            if (normalized.hint)
                hints.push({ rule: name, message: normalized.hint });
            presenter?.check?.({ check: normalized, mode: effectiveMode, outcome: "violation" });
        },
        finish(extra = {}) {
            const exitCode = enforcedFailures ? 1 : 0, result = violations ? "failed" : warnings ? "passed_with_warnings" : "passed";
            const report = { command: extra.command || null, mode, ok: violations === 0, result, passed, violations: violationDetails, advisoryWarnings: warningDetails, warnings, violationCount: violations, failed: enforcedFailures, exitCode, ruleResults, hints, ...extra };
            presenter?.finish?.(report);
            return report;
        },
        get violations() { return violations; },
    };
}
