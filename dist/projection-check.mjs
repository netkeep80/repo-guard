import { parseJson, } from "./document-facts.mjs";
import { analyzeProjectionCurrent, } from "./projection-analysis.mjs";
import { normalizeProjectionBuildRecordDetached, normalizeProjectionModel, } from "./projection-model.mjs";
import { analyzeProjectionOwnership, } from "./projection-ownership.mjs";
function fail(message) {
    throw new Error(message);
}
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail(label + " must be an object");
    }
    return value;
}
function fields(value, allowed, label) {
    const set = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !set.has(key)).sort();
    if (unknown.length)
        fail(label + " contains unknown field(s): " + unknown.join(", "));
}
function nonEmpty(value, label) {
    if (typeof value !== "string" || !value.trim())
        fail(label + " must be a non-empty string");
    return value.trim();
}
function digest(value, label) {
    const normalized = nonEmpty(value, label).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized))
        fail(label + " must be a sha256 digest");
    return normalized;
}
function currentGenerator(value, label) {
    const input = object(value, label);
    fields(input, ["tool_identity", "configuration_digest"], label);
    return {
        tool_identity: nonEmpty(input.tool_identity, label + ".tool_identity"),
        configuration_digest: digest(input.configuration_digest, label + ".configuration_digest"),
    };
}
function entry(value, index) {
    const label = `ProjectionCheck.entries[${index}]`;
    const input = object(value, label);
    fields(input, ["state", "model", "build", "current_generator"], label);
    const model = normalizeProjectionModel(input.model);
    if (input.state === "retained") {
        if (input.build !== undefined || input.current_generator !== undefined) {
            fail(label + " retained entry must not define build/current_generator");
        }
        return { state: "retained", model };
    }
    if (input.state !== "live") {
        fail(label + '.state must be "live" or "retained"');
    }
    if (input.build === undefined || input.current_generator === undefined) {
        fail(label + " live entry requires build and current_generator");
    }
    return {
        state: "live",
        model,
        build: normalizeProjectionBuildRecordDetached(input.build),
        current_generator: currentGenerator(input.current_generator, label + ".current_generator"),
    };
}
export function parseProjectionCheckState(raw) {
    if (raw === null || raw === undefined) {
        return {
            schema: "repo-guard/projection-check/v0",
            entries: [],
            present: false,
        };
    }
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const input = object(parseJson(text), "ProjectionCheck");
    fields(input, ["schema", "entries"], "ProjectionCheck");
    if (input.schema !== "repo-guard/projection-check/v0") {
        fail('ProjectionCheck.schema must be "repo-guard/projection-check/v0"');
    }
    if (!Array.isArray(input.entries))
        fail("ProjectionCheck.entries must be an array");
    const entries = input.entries.map(entry).sort((left, right) => left.model.id.localeCompare(right.model.id, "en")
        || left.state.localeCompare(right.state, "en"));
    return {
        schema: "repo-guard/projection-check/v0",
        entries,
        present: true,
    };
}
export function evaluateProjectionCheck(input) {
    const diagnostics = [];
    let base;
    let head;
    try {
        base = parseProjectionCheckState(input.baseRaw);
    }
    catch (error) {
        diagnostics.push({
            code: "projection_base_state_invalid",
            subject: ".repo-guard/projections.json",
            detail: error instanceof Error ? error.message : String(error),
        });
        base = {
            schema: "repo-guard/projection-check/v0",
            entries: [],
            present: true,
        };
    }
    try {
        head = parseProjectionCheckState(input.headRaw);
    }
    catch (error) {
        diagnostics.push({
            code: "projection_head_state_invalid",
            subject: ".repo-guard/projections.json",
            detail: error instanceof Error ? error.message : String(error),
        });
        head = {
            schema: "repo-guard/projection-check/v0",
            entries: [],
            present: true,
        };
    }
    const live = head.entries.filter((item) => item.state === "live");
    const retained = head.entries.filter((item) => item.state === "retained");
    const ownership = analyzeProjectionOwnership({
        live: live.map((item) => item.model),
        retained: retained.map((item) => item.model),
        base: base.entries.map((item) => item.model),
        readHead: input.readHead,
    });
    for (const conflict of ownership.conflicts) {
        diagnostics.push({
            code: "projection_ownership_" + conflict.code,
            subject: conflict.subject,
            ...(conflict.detail ? { detail: conflict.detail } : {}),
        });
    }
    for (const key of ownership.missing) {
        diagnostics.push({ code: "projection_missing", subject: key });
    }
    for (const key of ownership.orphan) {
        diagnostics.push({ code: "projection_orphan", subject: key });
    }
    const analyses = live.map((item) => analyzeProjectionCurrent(item.model, item.build, input.facts, item.current_generator)).sort((left, right) => (left.projection_id || "").localeCompare(right.projection_id || "", "en"));
    for (const analysis of analyses) {
        if (analysis.freshness === "CURRENT")
            continue;
        diagnostics.push({
            code: "projection_" + analysis.freshness.toLowerCase(),
            subject: analysis.projection_id || "<invalid>",
            detail: analysis.reasons.join(","),
        });
    }
    diagnostics.sort((left, right) => left.code.localeCompare(right.code, "en")
        || left.subject.localeCompare(right.subject, "en")
        || (left.detail || "").localeCompare(right.detail || "", "en"));
    return {
        ok: diagnostics.length === 0 && ownership.ok,
        present: base.present || head.present,
        ownership,
        analyses,
        diagnostics,
    };
}
