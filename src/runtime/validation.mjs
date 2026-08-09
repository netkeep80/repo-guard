import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { compileAnchorPolicy, compileChangeProfiles, compileForbidRegex, compileIntegrationPolicy, warnReservedPolicyFields } from "../policy-compiler.mjs";
import { resolvePolicyProfile } from "../policy-profiles.mjs";

export const loadJSON = (path) => JSON.parse(readFileSync(path, "utf-8"));
export const createAjv = () => new Ajv({ allErrors: true });
export const ajvErrors = (errors) => (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);

export function validate(ajv, schema, data, label, { quiet = false } = {}) {
  const valid = ajv.validate(schema, data);
  if (!quiet) {
    console[valid ? "log" : "error"](`${valid ? "OK" : "FAIL"}: ${label}`);
    if (!valid) for (const error of ajv.errors) console.error(`  ${error.instancePath || "/"} ${error.message}`);
  }
  return valid;
}

export function validationCheck(ajv, schema, data, label) {
  return ajv.validate(schema, data) ? { ok: true } : {
    ok: false, message: `${label} failed schema validation`, errors: ajvErrors(ajv.errors),
  };
}

export function loadPolicyRuntimeFromObject(roots, rawPolicy, options = {}) {
  const policySchema = loadJSON(resolve(roots.packageRoot, "schemas/repo-policy.schema.json"));
  const contractSchema = loadJSON(resolve(roots.packageRoot, "schemas/change-contract.schema.json"));
  const ajv = createAjv(), quiet = options.quiet || false, label = options.label || "repo-policy.json";
  let ok = validate(ajv, policySchema, rawPolicy, label, { quiet });

  const profile = resolvePolicyProfile(rawPolicy);
  const policy = profile.policy;
  const groups = [
    ["profile compilation", profile.errors, (error) => error.message],
    ["forbid_regex compilation", compileForbidRegex(policy.content_rules), (error) => `[${error.rule_id}] invalid regex /${error.pattern}/: ${error.message}`],
    ["change_profiles compilation", compileChangeProfiles(policy), (error) => error.message],
    ["anchor policy compilation", compileAnchorPolicy(policy), (error) => error.message],
    ["integration policy compilation", compileIntegrationPolicy(policy), (error) => error.message],
  ];
  for (const [group, errors, format] of groups) if (errors.length) {
    ok = false;
    if (!quiet) { console.error(`FAIL: ${group}`); for (const error of errors) console.error(`  ${format(error)}`); }
  }
  if (!quiet) for (const warning of warnReservedPolicyFields(policy)) console.warn(`WARN: ${warning}`);
  return { ok, ajv, policy, contractSchema };
}

export function loadPolicyRuntime(roots, options = {}) {
  return loadPolicyRuntimeFromObject(roots, loadJSON(resolve(roots.repoRoot, "repo-policy.json")), options);
}
