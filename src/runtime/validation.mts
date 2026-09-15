import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileConstraintProgram, type ConstraintProgramEntry } from "../checks/constraint-program.mjs";
import { compileAnchorPolicy, compileChangeProfiles, compileCochangeGroupsPolicy, compileDocumentRelationsPolicy, compileEvidenceBindingsPolicy, compileForbidRegex } from "../policy-compiler.mjs";
import { resolvePolicyPacks } from "../policy-packs.mjs";
import { projectPolicyToCurrentVocabulary } from "../policy-vocabulary.mjs";

type AjvErrorProjection = { instancePath?: string; message?: string };
interface AjvValidator {
  (data: unknown): boolean;
  errors: readonly AjvErrorProjection[] | null;
}
interface AjvRuntime {
  errors: readonly AjvErrorProjection[] | null;
  compile(schema: unknown): AjvValidator;
  validate(schema: unknown, data: unknown): boolean;
}
type AjvConstructor = new (options?: { allErrors?: boolean; allowUnionTypes?: boolean }) => AjvRuntime;
type AjvSchema = unknown;
type RuntimePolicyProjection = NonNullable<Parameters<typeof compileConstraintProgram>[0]> & NonNullable<Parameters<typeof compileChangeProfiles>[0]> & { content_rules?: unknown };
type SemanticGroup = readonly [string, readonly unknown[], (error: unknown) => string];
type SchemaKey = "repoPolicy" | "changeIntent" | "governanceGrant";
interface RuntimeRoots { packageRoot: string; repoRoot: string; }
interface RuntimeSchemas { repoPolicy?: AjvSchema; changeIntent?: AjvSchema; governanceGrant?: AjvSchema; }
interface RuntimeValidationOptions { quiet?: boolean; label?: string; schemas?: RuntimeSchemas; historicalBase?: boolean; context?: PolicyNormalizationContext; }
interface PolicyNormalizationOptions { quiet?: boolean; label?: string; historicalBase?: boolean; }
interface QuietOption { quiet?: boolean; }
export interface PolicyNormalizationError { stage: "schema" | "pack" | "semantic" | "program"; group: string; message: string; }
export interface PolicyNormalizationProvenance { schemaAuthority: string; historicalBaseProjection: boolean; packs: string[]; }
export interface PolicyNormalizationResult {
  ok: boolean;
  rawPolicy: unknown;
  observedPolicy: unknown;
  policy: RuntimePolicyProjection | null;
  constraintProgram: ConstraintProgramEntry[] | null;
  errors: PolicyNormalizationError[];
  provenance: PolicyNormalizationProvenance;
}
export interface PolicyNormalizationContext {
  roots: RuntimeRoots;
  ajv: AjvRuntime;
  schemas: Record<SchemaKey, AjvSchema>;
  authorities: Record<SchemaKey, string>;
  validatorFor(key: SchemaKey): AjvValidator;
}

const SCHEMAS: Record<SchemaKey, string> = {
  repoPolicy: "repo-policy",
  changeIntent: "change-intent",
  governanceGrant: "governance-grant",
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export const loadJSON = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));
// Draft-07 разрешает массив типов. Оставляем Ajv strict mode включённым, но явно
// разрешаем этот стандартный синтаксис, чтобы валидная policy не писала warning в stderr.
export const createAjv = (): AjvRuntime => new (Ajv as unknown as AjvConstructor)({ allErrors: true, allowUnionTypes: true });
export const ajvErrors = (errors: readonly AjvErrorProjection[] | null | undefined): string[] => (errors || [])
  .map((error) => `${error.instancePath || "/"} ${error.message}`)
  .sort();

function packageAuthority(packageRoot: string): string {
  try {
    const metadata = object(loadJSON(resolve(packageRoot, "package.json")));
    return `${typeof metadata.name === "string" ? metadata.name : "repo-guard"}@${typeof metadata.version === "string" ? metadata.version : "unknown"}`;
  } catch {
    return "repo-guard@unknown";
  }
}

function schemaAuthority(authority: string, schema: AjvSchema): string {
  const id = object(schema).$id;
  return `${authority}|${typeof id === "string" ? id : "anonymous-schema"}|sha256:${digest(schema)}`;
}

export function createPolicyNormalizationContext(roots: RuntimeRoots, options: Pick<RuntimeValidationOptions, "schemas"> = {}): PolicyNormalizationContext {
  const schemas = Object.fromEntries((Object.keys(SCHEMAS) as SchemaKey[]).map((key) => [
    key,
    options.schemas?.[key] ?? loadJSON(resolve(roots.packageRoot, `schemas/${SCHEMAS[key]}.schema.json`)),
  ])) as Record<SchemaKey, AjvSchema>;
  const authority = packageAuthority(roots.packageRoot);
  const authorities = Object.fromEntries((Object.keys(SCHEMAS) as SchemaKey[]).map((key) => [key, schemaAuthority(authority, schemas[key])])) as Record<SchemaKey, string>;
  const ajv = createAjv(), validatorCache = new Map<string, AjvValidator>();
  const validatorFor = (key: SchemaKey): AjvValidator => {
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

export function validate(ajv: AjvRuntime, schema: AjvSchema, data: unknown, label: string, { quiet = false }: QuietOption = {}) {
  const valid = ajv.validate(schema, data);
  if (!quiet) {
    console[valid ? "log" : "error"](`${valid ? "OK" : "FAIL"}: ${label}`);
    if (!valid) for (const error of ajvErrors(ajv.errors)) console.error(`  ${error}`);
  }
  return valid;
}

export function validationCheck(ajv: AjvRuntime, schema: AjvSchema, data: unknown, label: string) {
  return ajv.validate(schema, data) ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(ajv.errors) };
}

export function validationContextCheck(context: PolicyNormalizationContext, key: Exclude<SchemaKey, "repoPolicy">, data: unknown, label: string) {
  const validator = context.validatorFor(key), valid = validator(data);
  return valid ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(validator.errors) };
}

function packNames(policy: unknown): string[] {
  const packs = object(object(policy).packs);
  return Object.keys(packs).sort();
}

function printGroup(group: string, messages: readonly string[], quiet: boolean) {
  if (quiet || !messages.length) return;
  console.error(`FAIL: ${group}`);
  for (const message of messages) console.error(`  ${message}`);
}

export function normalizePolicy(context: PolicyNormalizationContext, rawPolicy: unknown, options: PolicyNormalizationOptions = {}): PolicyNormalizationResult {
  const quiet = options.quiet || false, label = options.label || "repo-policy.json", policySchema = context.schemas.repoPolicy;
  const observedPolicy = options.historicalBase ? projectPolicyToCurrentVocabulary(rawPolicy, policySchema) : rawPolicy;
  const provenance: PolicyNormalizationProvenance = {
    schemaAuthority: context.authorities.repoPolicy,
    historicalBaseProjection: options.historicalBase === true,
    packs: packNames(observedPolicy),
  };
  const validator = context.validatorFor("repoPolicy"), shapeOk = validator(observedPolicy);
  if (!quiet) console[shapeOk ? "log" : "error"](`${shapeOk ? "OK" : "FAIL"}: ${label}`);
  if (!shapeOk) {
    const messages = ajvErrors(validator.errors);
    if (!quiet) for (const message of messages) console.error(`  ${message}`);
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

  const policy = packResult.policy as RuntimePolicyProjection;
  const semanticGroups: SemanticGroup[] = [
    ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${(error as { rule_id?: unknown }).rule_id}] invalid regex /${(error as { pattern?: unknown }).pattern}/: ${(error as { message: string }).message}`],
    ["change_profiles compilation", compileChangeProfiles(policy), (error) => (error as { message: string }).message],
    ["anchor policy compilation", compileAnchorPolicy(policy), (error) => (error as { message: string }).message],
    ["cochange group compilation", compileCochangeGroupsPolicy(policy), (error) => (error as { message: string }).message],
    ["document relation policy compilation", compileDocumentRelationsPolicy(policy), (error) => (error as { message: string }).message],
    ["evidence binding policy compilation", compileEvidenceBindingsPolicy(policy), (error) => (error as { message: string }).message],
  ];
  const errors: PolicyNormalizationError[] = [];
  for (const [group, groupErrors, format] of semanticGroups) {
    const messages = groupErrors.map(format).sort();
    printGroup(group, messages, quiet);
    errors.push(...messages.map((message) => ({ stage: "semantic" as const, group, message })));
  }
  if (errors.length) return { ok: false, rawPolicy, observedPolicy, policy, constraintProgram: null, errors, provenance };

  try {
    const constraintProgram = compileConstraintProgram(policy, null);
    return { ok: true, rawPolicy, observedPolicy, policy, constraintProgram, errors: [], provenance };
  } catch (error: unknown) {
    const message = (error as Error).message;
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

export function loadPolicyRuntimeFromObject(roots: RuntimeRoots, rawPolicy: unknown, options: RuntimeValidationOptions = {}) {
  const context = options.context ?? createPolicyNormalizationContext(roots, options), normalized = normalizePolicy(context, rawPolicy, options);
  const policy = (normalized.policy ?? normalized.observedPolicy) as RuntimePolicyProjection;
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

export function loadPolicyRuntime(roots: RuntimeRoots, options: RuntimeValidationOptions = {}) {
  return loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
}
