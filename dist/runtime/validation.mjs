import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileConstraintProgram } from "../checks/constraint-program.mjs";
import { compileAnchorPolicy, compileChangeProfiles, compileCochangeGroupsPolicy, compileDocumentRelationsPolicy, compileEvidenceBindingsPolicy, compileForbidRegex } from "../policy-compiler.mjs";
import { resolvePolicyPacks } from "../policy-packs.mjs";
import { projectPolicyToCurrentVocabulary } from "../policy-vocabulary.mjs";
const SCHEMAS = {
    repoPolicy: "repo-policy",
    changeIntent: "change-intent",
    governanceGrant: "governance-grant",
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
        : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const loadJSON = (path) => JSON.parse(readFileSync(path, "utf-8"));
// Draft-07 разрешает массив типов. Оставляем Ajv strict mode включённым, но явно
// разрешаем этот стандартный синтаксис, чтобы валидная policy не писала warning в stderr.
export const createAjv = () => new Ajv({ allErrors: true, allowUnionTypes: true });
export const ajvErrors = (errors) => (errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .sort();
function packageAuthority(packageRoot) {
    try {
        const metadata = object(loadJSON(resolve(packageRoot, "package.json")));
        return `${typeof metadata.name === "string" ? metadata.name : "repo-guard"}@${typeof metadata.version === "string" ? metadata.version : "unknown"}`;
    }
    catch {
        return "repo-guard@unknown";
    }
}
function schemaAuthority(authority, schema) {
    const id = object(schema).$id;
    return `${authority}|${typeof id === "string" ? id : "anonymous-schema"}|sha256:${digest(schema)}`;
}
export function createPolicyNormalizationContext(roots, options = {}) {
    const schemas = Object.fromEntries(Object.keys(SCHEMAS).map((key) => [
        key,
        options.schemas?.[key] ?? loadJSON(resolve(roots.packageRoot, `schemas/${SCHEMAS[key]}.schema.json`)),
    ]));
    const authority = packageAuthority(roots.packageRoot);
    const authorities = Object.fromEntries(Object.keys(SCHEMAS).map((key) => [key, schemaAuthority(authority, schemas[key])]));
    const ajv = createAjv(), validatorCache = new Map();
    const validatorFor = (key) => {
        const cacheKey = authorities[key];
        let validator = validatorCache.get(cacheKey);
        if (!validator) {
            validator = ajv.compile(schemas[key]);
            validatorCache.set(cacheKey, validator);
        }
        return validator;
    };
    return { roots, ajv, schemas, authorities, validatorFor };
}
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
export function validationContextCheck(context, key, data, label) {
    const validator = context.validatorFor(key), valid = validator(data);
    return valid ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(validator.errors) };
}
function packNames(policy) {
    const packs = object(object(policy).packs);
    return Object.keys(packs).sort();
}
function printGroup(group, messages, quiet) {
    if (quiet || !messages.length)
        return;
    console.error(`FAIL: ${group}`);
    for (const message of messages)
        console.error(`  ${message}`);
}
export function normalizePolicy(context, rawPolicy, options = {}) {
    const quiet = options.quiet || false, label = options.label || "repo-policy.json", policySchema = context.schemas.repoPolicy;
    const observedPolicy = options.historicalBase ? projectPolicyToCurrentVocabulary(rawPolicy, policySchema) : rawPolicy;
    const provenance = {
        schemaAuthority: context.authorities.repoPolicy,
        historicalBaseProjection: options.historicalBase === true,
        packs: packNames(observedPolicy),
    };
    const validator = context.validatorFor("repoPolicy"), shapeOk = validator(observedPolicy);
    if (!quiet)
        console[shapeOk ? "log" : "error"](`${shapeOk ? "OK" : "FAIL"}: ${label}`);
    if (!shapeOk) {
        const messages = ajvErrors(validator.errors);
        if (!quiet)
            for (const message of messages)
                console.error(`  ${message}`);
        return {
            ok: false,
            rawPolicy,
            observedPolicy,
            policy: null,
            constraintProgram: null,
            errors: messages.map((message) => ({ stage: "schema", group: "repo-policy schema", message })),
            provenance,
        };
    }
    const packResult = resolvePolicyPacks(observedPolicy);
    if (!packResult.ok) {
        const messages = packResult.errors.map((error) => error.message).sort();
        printGroup("pack compilation", messages, quiet);
        return {
            ok: false,
            rawPolicy,
            observedPolicy,
            policy: null,
            constraintProgram: null,
            errors: messages.map((message) => ({ stage: "pack", group: "pack compilation", message })),
            provenance,
        };
    }
    const policy = packResult.policy;
    const semanticGroups = [
        ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${error.rule_id}] invalid regex /${error.pattern}/: ${error.message}`],
        ["change_profiles compilation", compileChangeProfiles(policy), (error) => error.message],
        ["anchor policy compilation", compileAnchorPolicy(policy), (error) => error.message],
        ["cochange group compilation", compileCochangeGroupsPolicy(policy), (error) => error.message],
        ["document relation policy compilation", compileDocumentRelationsPolicy(policy), (error) => error.message],
        ["evidence binding policy compilation", compileEvidenceBindingsPolicy(policy), (error) => error.message],
    ];
    const errors = [];
    for (const [group, groupErrors, format] of semanticGroups) {
        const messages = groupErrors.map(format).sort();
        printGroup(group, messages, quiet);
        errors.push(...messages.map((message) => ({ stage: "semantic", group, message })));
    }
    if (errors.length)
        return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors, provenance };
    try {
        const constraintProgram = compileConstraintProgram(policy, null);
        return { ok: true, rawPolicy, observedPolicy, policy, constraintProgram, errors: [], provenance };
    }
    catch (error) {
        const message = error.message;
        printGroup("constraint program compilation", [message], quiet);
        return {
            ok: false,
            rawPolicy,
            observedPolicy,
            policy,
            constraintProgram: null,
            errors: [{ stage: "program", group: "constraint program compilation", message }],
            provenance,
        };
    }
}
export function loadPolicyRuntimeFromObject(roots, rawPolicy, options = {}) {
    const context = options.context ?? createPolicyNormalizationContext(roots, options), normalized = normalizePolicy(context, rawPolicy, options);
    const policy = (normalized.policy ?? normalized.observedPolicy);
    return {
        ok: normalized.ok,
        ajv: context.ajv,
        policy,
        changeIntentSchema: context.schemas.changeIntent,
        governanceGrantSchema: context.schemas.governanceGrant,
        context,
        constraintProgram: normalized.constraintProgram,
        provenance: normalized.provenance,
        errors: normalized.errors,
    };
}
export function loadPolicyRuntime(roots, options = {}) {
    return loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
}
