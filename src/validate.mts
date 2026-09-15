import { resolve } from "node:path";
import { loadJSON, loadPolicyRuntime, validate } from "./runtime/validation.mjs";

type ValidateRoots = Parameters<typeof loadPolicyRuntime>[0];

export function runValidate(roots: ValidateRoots, args: string[]) {
  const runtime = loadPolicyRuntime(roots);
  const { ajv, changeIntentSchema } = runtime;
  let ok = runtime.ok;
  if (args[0]) ok = validate(ajv, changeIntentSchema, loadJSON(resolve(roots.repoRoot, args[0])), args[0]) && ok;
  return ok ? 0 : 1;
}
