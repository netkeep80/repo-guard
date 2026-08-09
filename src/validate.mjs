import { resolve } from "node:path";
import { warnReservedContractFields } from "./policy-compiler.mjs";
import { loadJSON, loadPolicyRuntime, validate } from "./runtime/validation.mjs";

export function runValidate(roots, args) {
  const runtime = loadPolicyRuntime(roots);
  const { ajv, contractSchema } = runtime;
  let ok = runtime.ok;
  const contractArg = args[0];
  if (contractArg) {
    const contract = loadJSON(resolve(roots.repoRoot, contractArg));
    ok = validate(ajv, contractSchema, contract, contractArg) && ok;
    for (const warning of warnReservedContractFields(contract)) console.warn(`WARN: ${warning}`);
  }
  return ok ? 0 : 1;
}
