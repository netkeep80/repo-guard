import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileConstraintProgram } from "../checks/constraint-program.mjs";
import { compileAnchorPolicy, compileChangeProfiles, compileCochangeGroupsPolicy, compileDocumentRelationsPolicy, compileEvidenceBindingsPolicy, compileForbidRegex } from "../policy-compiler.mjs";
import { resolvePolicyPacks } from "../policy-packs.mjs";
import { projectPolicyToCurrentVocabulary } from "../policy-vocabulary.mjs";
const SCHEMAS = { repoPolicy: "repo-policy", changeIntent: "change-intent", governanceGrant: "governance-grant" };
const keys = Object.keys(SCHEMAS);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const packageAuthority = (root) => { try {
    const value = object(loadJSON(resolve(root, "package.json")));
    return `${typeof value.name === "string" ? value.name : "repo-guard"}@${typeof value.version === "string" ? value.version : "unknown"}`;
}
catch {
    return "repo-guard@unknown";
} };
export const loadJSON = (path) => JSON.parse(readFileSync(path, "utf-8"));
export const createAjv = () => new Ajv({ allErrors: true, allowUnionTypes: true });
export const ajvErrors = (errors) => (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).sort();
export function createPolicyNormalizationContext(roots, options = {}) {
    const schemas = Object.fromEntries(keys.map((key) => [key, options.schemas?.[key] ?? loadJSON(resolve(roots.packageRoot, `schemas/${SCHEMAS[key]}.schema.json`))]));
    const authority = packageAuthority(roots.packageRoot);
    const authorities = Object.fromEntries(keys.map((key) => [key, `${authority}|${typeof object(schemas[key]).$id === "string" ? object(schemas[key]).$id : "anonymous-schema"}|sha256:${digest(schemas[key])}`]));
    const ajv = createAjv(), validators = new Map();
    for (const key of keys)
        validators.set(authorities[key], ajv.compile(schemas[key]));
    return { roots, ajv, schemas, authorities, validatorFor: (key) => validators.get(authorities[key]) };
}
const contexts = new WeakMap();
const runtimeContext = (roots, options) => {
    if (options.context)
        return options.context;
    if (options.schemas)
        return createPolicyNormalizationContext(roots, options);
    const found = contexts.get(roots);
    if (found)
        return found;
    const created = createPolicyNormalizationContext(roots);
    contexts.set(roots, created);
    return created;
};
export function validate(ajv, schema, data, label, { quiet = false } = {}) {
    const valid = ajv.validate(schema, data);
    if (!quiet) {
        console[valid ? "log" : "error"](`${valid ? "OK" : "FAIL"}: ${label}`);
        if (!valid)
            for (const error of ajvErrors(ajv.errors))
                console.error(`  ${error}`);
    }
    return valid;
}
export function validationCheck(ajv, schema, data, label) {
    return ajv.validate(schema, data) ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(ajv.errors) };
}
const packNames = (policy) => Object.keys(object(object(policy).packs)).sort();
const printGroup = (group, messages, quiet) => { if (!quiet && messages.length) {
    console.error(`FAIL: ${group}`);
    for (const message of messages)
        console.error(`  ${message}`);
} };
export function normalizePolicy(context, rawPolicy, options = {}) {
    const quiet = options.quiet || false, label = options.label || "repo-policy.json", schema = context.schemas.repoPolicy;
    const observedPolicy = options.historicalBase ? projectPolicyToCurrentVocabulary(rawPolicy, schema) : rawPolicy;
    const provenance = { schemaAuthority: context.authorities.repoPolicy, historicalBaseProjection: options.historicalBase === true, packs: packNames(observedPolicy) };
    const validator = context.validatorFor("repoPolicy"), shapeOk = validator(observedPolicy);
    if (!quiet)
        console[shapeOk ? "log" : "error"](`${shapeOk ? "OK" : "FAIL"}: ${label}`);
    if (!shapeOk) {
        const messages = ajvErrors(validator.errors);
        if (!quiet)
            for (const message of messages)
                console.error(`  ${message}`);
        return { ok: false, rawPolicy, observedPolicy, policy: null, constraintProgram: null, errors: messages.map((message) => ({ stage: "schema", group: "repo-policy schema", message })), provenance };
    }
    const packed = resolvePolicyPacks(observedPolicy);
    if (!packed.ok) {
        const messages = packed.errors.map((error) => error.message).sort();
        printGroup("pack compilation", messages, quiet);
        return { ok: false, rawPolicy, observedPolicy, policy: null, constraintProgram: null, errors: messages.map((message) => ({ stage: "pack", group: "pack compilation", message })), provenance };
    }
    const policy = packed.policy;
    const groups = [
        ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${error.rule_id}] invalid regex /${error.pattern}/: ${error.message}`],
        ["change_profiles compilation", compileChangeProfiles(policy), (error) => error.message],
        ["anchor policy compilation", compileAnchorPolicy(policy), (error) => error.message],
        ["cochange group compilation", compileCochangeGroupsPolicy(policy), (error) => error.message],
        ["document relation policy compilation", compileDocumentRelationsPolicy(policy), (error) => error.message],
        ["evidence binding policy compilation", compileEvidenceBindingsPolicy(policy), (error) => error.message],
    ];
    const errors = groups.flatMap(([group, items, format]) => { const messages = items.map(format).sort(); printGroup(group, messages, quiet); return messages.map((message) => ({ stage: "semantic", group, message })); });
    if (errors.length)
        return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors, provenance };
    try {
        return { ok: true, rawPolicy, observedPolicy, policy, constraintProgram: compileConstraintProgram(policy, null), errors: [], provenance };
    }
    catch (error) {
        const message = error.message;
        printGroup("constraint program compilation", [message], quiet);
        return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors: [{ stage: "program", group: "constraint program compilation", message }], provenance };
    }
}
export function loadPolicyRuntimeFromObject(roots, rawPolicy, options = {}) {
    const context = runtimeContext(roots, options), normalized = normalizePolicy(context, rawPolicy, options), policy = (normalized.policy ?? normalized.observedPolicy);
    return { ok: normalized.ok, ajv: context.ajv, policy, changeIntentSchema: context.schemas.changeIntent, governanceGrantSchema: context.schemas.governanceGrant, context, constraintProgram: normalized.constraintProgram, provenance: normalized.provenance, errors: normalized.errors };
}
export const loadPolicyRuntime = (roots, options = {}) => loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
