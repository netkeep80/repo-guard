import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileConstraintProgram } from "../checks/constraint-program.mjs";
import { compileAnchorPolicy, compileChangeProfiles, compileCochangeGroupsPolicy, compileDocumentRelationsPolicy, compileEvidenceBindingsPolicy, compileForbidRegex } from "../policy-compiler.mjs";
import { resolvePolicyPacks } from "../policy-packs.mjs";
import { projectPolicyToCurrentVocabulary } from "../policy-vocabulary.mjs";
type AjvError = { instancePath?: string; message?: string };
type Validator = ((data: unknown) => boolean) & { errors?: readonly AjvError[] | null };
interface AjvRuntime { errors: readonly AjvError[] | null; compile(schema: unknown): Validator; validate(schema: unknown, data: unknown): boolean; }
type AjvConstructor = new (options?: { allErrors?: boolean; allowUnionTypes?: boolean }) => AjvRuntime;
type RuntimeRoots = { packageRoot: string; repoRoot: string };
type RuntimePolicy = NonNullable<Parameters<typeof compileConstraintProgram>[0]> & NonNullable<Parameters<typeof compileChangeProfiles>[0]> & { content_rules?: unknown };
type SemanticGroup = readonly [string, readonly unknown[], (error: unknown) => string];
const SCHEMAS = { repoPolicy: "repo-policy", changeIntent: "change-intent", governanceGrant: "governance-grant" } as const;
type SchemaKey = keyof typeof SCHEMAS;
type RuntimeSchemas = Partial<Record<SchemaKey, unknown>>;
const keys = Object.keys(SCHEMAS) as SchemaKey[];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const packageAuthority = (root: string) => { try { const value = object(loadJSON(resolve(root, "package.json"))); return `${typeof value.name === "string" ? value.name : "repo-guard"}@${typeof value.version === "string" ? value.version : "unknown"}`; } catch { return "repo-guard@unknown"; } };
export const loadJSON = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));
export const createAjv = (): AjvRuntime => new (Ajv as unknown as AjvConstructor)({ allErrors: true, allowUnionTypes: true });
export const ajvErrors = (errors: readonly AjvError[] | null | undefined) => (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).sort();
export function createPolicyNormalizationContext(roots: RuntimeRoots, options: { schemas?: RuntimeSchemas } = {}) {
  const schemas = Object.fromEntries(keys.map((key) => [key, options.schemas?.[key] ?? loadJSON(resolve(roots.packageRoot, `schemas/${SCHEMAS[key]}.schema.json`))])) as Record<SchemaKey, unknown>;
  const authority = packageAuthority(roots.packageRoot);
  const authorities = Object.fromEntries(keys.map((key) => [key, `${authority}|${typeof object(schemas[key]).$id === "string" ? object(schemas[key]).$id : "anonymous-schema"}|sha256:${digest(schemas[key])}`])) as Record<SchemaKey, string>;
  const ajv = createAjv(), validators = new Map<string, Validator>();
  for (const key of keys) validators.set(authorities[key], ajv.compile(schemas[key]));
  return { roots, ajv, schemas, authorities, validatorFor: (key: SchemaKey) => validators.get(authorities[key])! };
}
export type PolicyNormalizationContext = ReturnType<typeof createPolicyNormalizationContext>;
type RuntimeOptions = { quiet?: boolean; label?: string; schemas?: RuntimeSchemas; historicalBase?: boolean; context?: PolicyNormalizationContext };
const contexts = new WeakMap<RuntimeRoots, PolicyNormalizationContext>();
const runtimeContext = (roots: RuntimeRoots, options: RuntimeOptions) => {
  if (options.context) return options.context;
  if (options.schemas) return createPolicyNormalizationContext(roots, options);
  const found = contexts.get(roots); if (found) return found;
  const created = createPolicyNormalizationContext(roots); contexts.set(roots, created); return created;
};
export function validate(ajv: AjvRuntime, schema: unknown, data: unknown, label: string, { quiet = false } = {}) {
  const valid = ajv.validate(schema, data);
  if (!quiet) { console[valid ? "log" : "error"](`${valid ? "OK" : "FAIL"}: ${label}`); if (!valid) for (const error of ajvErrors(ajv.errors)) console.error(`  ${error}`); }
  return valid;
}
export function validationCheck(ajv: AjvRuntime, schema: unknown, data: unknown, label: string) {
  return ajv.validate(schema, data) ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(ajv.errors) };
}
const packNames = (policy: unknown) => Object.keys(object(object(policy).packs)).sort();
const printGroup = (group: string, messages: readonly string[], quiet: boolean) => { if (!quiet && messages.length) { console.error(`FAIL: ${group}`); for (const message of messages) console.error(`  ${message}`); } };
export function normalizePolicy(context: PolicyNormalizationContext, rawPolicy: unknown, options: { quiet?: boolean; label?: string; historicalBase?: boolean } = {}) {
  const quiet = options.quiet || false, label = options.label || "repo-policy.json", schema = context.schemas.repoPolicy;
  const observedPolicy = options.historicalBase ? projectPolicyToCurrentVocabulary(rawPolicy, schema) : rawPolicy;
  const provenance = { schemaAuthority: context.authorities.repoPolicy, historicalBaseProjection: options.historicalBase === true, packs: packNames(observedPolicy) };
  const validator = context.validatorFor("repoPolicy"), shapeOk = validator(observedPolicy);
  if (!quiet) console[shapeOk ? "log" : "error"](`${shapeOk ? "OK" : "FAIL"}: ${label}`);
  if (!shapeOk) { const messages = ajvErrors(validator.errors); if (!quiet) for (const message of messages) console.error(`  ${message}`); return { ok: false, rawPolicy, observedPolicy, policy: null, constraintProgram: null, errors: messages.map((message) => ({ stage: "schema" as const, group: "repo-policy schema", message })), provenance }; }
  const packed = resolvePolicyPacks(observedPolicy);
  if (!packed.ok) { const messages = packed.errors.map((error) => error.message).sort(); printGroup("pack compilation", messages, quiet); return { ok: false, rawPolicy, observedPolicy, policy: null, constraintProgram: null, errors: messages.map((message) => ({ stage: "pack" as const, group: "pack compilation", message })), provenance }; }
  const policy = packed.policy as RuntimePolicy;
  const groups: SemanticGroup[] = [
    ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${(error as { rule_id?: unknown }).rule_id}] invalid regex /${(error as { pattern?: unknown }).pattern}/: ${(error as { message: string }).message}`],
    ["change_profiles compilation", compileChangeProfiles(policy), (error) => (error as { message: string }).message],
    ["anchor policy compilation", compileAnchorPolicy(policy), (error) => (error as { message: string }).message],
    ["cochange group compilation", compileCochangeGroupsPolicy(policy), (error) => (error as { message: string }).message],
    ["document relation policy compilation", compileDocumentRelationsPolicy(policy), (error) => (error as { message: string }).message],
    ["evidence binding policy compilation", compileEvidenceBindingsPolicy(policy), (error) => (error as { message: string }).message],
  ];
  const errors = groups.flatMap(([group, items, format]) => { const messages = items.map(format).sort(); printGroup(group, messages, quiet); return messages.map((message) => ({ stage: "semantic" as const, group, message })); });
  if (errors.length) return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors, provenance };
  try { return { ok: true, rawPolicy, observedPolicy, policy, constraintProgram: compileConstraintProgram(policy, null), errors: [], provenance }; }
  catch (error: unknown) { const message = (error as Error).message; printGroup("constraint program compilation", [message], quiet); return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors: [{ stage: "program" as const, group: "constraint program compilation", message }], provenance }; }
}
export function loadPolicyRuntimeFromObject(roots: RuntimeRoots, rawPolicy: unknown, options: RuntimeOptions = {}) {
  const context = runtimeContext(roots, options), normalized = normalizePolicy(context, rawPolicy, options), policy = (normalized.policy ?? normalized.observedPolicy) as RuntimePolicy;
  return { ok: normalized.ok, ajv: context.ajv, policy, changeIntentSchema: context.schemas.changeIntent, governanceGrantSchema: context.schemas.governanceGrant, context, constraintProgram: normalized.constraintProgram, provenance: normalized.provenance, errors: normalized.errors };
}
export const loadPolicyRuntime = (roots: RuntimeRoots, options: RuntimeOptions = {}) => loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
