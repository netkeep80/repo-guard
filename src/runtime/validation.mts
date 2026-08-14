import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileAnchorPolicy, compileChangeProfiles, compileDocumentRelationsPolicy, compileForbidRegex, compileIntegrationPolicy, warnReservedPolicyFields } from "../policy-compiler.mjs";
import { resolvePolicyProfile } from "../policy-profiles.mjs";

type AjvErrorProjection = { instancePath?: string; message?: string };
interface AjvRuntime {
  errors: readonly AjvErrorProjection[] | null;
  validate(schema: unknown, data: unknown): boolean | Promise<unknown>;
}
type AjvConstructor = new (options?: { allErrors?: boolean }) => AjvRuntime;
type AjvSchema = unknown;
type RuntimePolicyProjection = Parameters<typeof compileChangeProfiles>[0] & { content_rules?: unknown };
type SemanticGroup = readonly [string, readonly unknown[], (error: unknown) => string];
interface RuntimeRoots { packageRoot: string; repoRoot: string; }
interface RuntimeValidationOptions { quiet?: boolean; label?: string; }
interface QuietOption { quiet?: boolean; }

export const loadJSON = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));
export const createAjv = (): AjvRuntime => new (Ajv as unknown as AjvConstructor)({ allErrors: true });
export const ajvErrors = (errors: readonly AjvErrorProjection[] | null | undefined): string[] => (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);
export function validate(ajv: AjvRuntime, schema: AjvSchema, data: unknown, label: string, { quiet = false }: QuietOption = {}) {
  const valid = ajv.validate(schema, data);
  if (!quiet) {
    console[valid ? "log" : "error"](`${valid ? "OK" : "FAIL"}: ${label}`);
    if (!valid) for (const error of ajv.errors as readonly AjvErrorProjection[]) console.error(`  ${error.instancePath || "/"} ${error.message}`);
  }
  return valid;
}
export function validationCheck(ajv: AjvRuntime, schema: AjvSchema, data: unknown, label: string) {
  return ajv.validate(schema, data) ? { ok: true } : { ok: false, message: `${label} failed schema validation`, errors: ajvErrors(ajv.errors) };
}

export function loadPolicyRuntimeFromObject(roots: RuntimeRoots, rawPolicy: unknown, options: RuntimeValidationOptions = {}) {
  const schema = (name: string): AjvSchema => loadJSON(resolve(roots.packageRoot, `schemas/${name}.schema.json`));
  const policySchema = schema("repo-policy"), changeIntentSchema = schema("change-intent"), governanceGrantSchema = schema("governance-grant");
  const ajv = createAjv(), quiet = options.quiet || false, label = options.label || "repo-policy.json";
  let ok = validate(ajv, policySchema, rawPolicy, label, { quiet });
  const profile = resolvePolicyProfile(rawPolicy), policy = profile.policy as RuntimePolicyProjection;
  const semanticGroups: SemanticGroup[] = [
    ["profile compilation", profile.errors, (error) => (error as { message: string }).message],
    ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${(error as { rule_id?: unknown }).rule_id}] invalid regex /${(error as { pattern?: unknown }).pattern}/: ${(error as { message: string }).message}`],
    ["change_profiles compilation", compileChangeProfiles(policy), (error) => (error as { message: string }).message],
    ["anchor policy compilation", compileAnchorPolicy(policy), (error) => (error as { message: string }).message],
    ["integration policy compilation", compileIntegrationPolicy(policy), (error) => (error as { message: string }).message],
    ["document relation policy compilation", compileDocumentRelationsPolicy(policy), (error) => (error as { message: string }).message],
  ];
  for (const [group, errors, format] of semanticGroups) if (errors.length) {
    ok = false;
    if (!quiet) { console.error(`FAIL: ${group}`); for (const error of errors) console.error(`  ${format(error)}`); }
  }
  if (!quiet) for (const warning of warnReservedPolicyFields(policy)) console.warn(`WARN: ${warning}`);
  return { ok, ajv, policy, changeIntentSchema, governanceGrantSchema };
}

export function loadPolicyRuntime(roots: RuntimeRoots, options: RuntimeValidationOptions = {}) {
  return loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
}
