import { resolve } from "node:path";
import { createPolicyNormalizationContext, loadJSON, loadPolicyRuntime, validationContextCheck } from "./runtime/validation.mjs";

type ValidateRoots = Parameters<typeof loadPolicyRuntime>[0];

export function runValidate(roots: ValidateRoots, args: string[]) {
  const context = createPolicyNormalizationContext(roots), runtime = loadPolicyRuntime(roots, { context });
  let ok = runtime.ok;
  if (args[0]) {
    const result = validationContextCheck(context, "changeIntent", loadJSON(resolve(roots.repoRoot, args[0])), args[0]);
    console[result.ok ? "log" : "error"](`${result.ok ? "OK" : "FAIL"}: ${args[0]}`);
    if (!result.ok) for (const error of result.errors || []) console.error(`  ${error}`);
    ok = result.ok && ok;
  }
  return ok ? 0 : 1;
}
