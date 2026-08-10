import { resolve } from "node:path";
import { getDiff } from "./git.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { renderAnalysisReport } from "./reporting/renderers.mjs";
import { loadJSON, loadPolicyRuntime, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";

const value = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
export function runCheckDiff(roots, args = []) {
  const base = value(args, "--base"), head = value(args, "--head"), contractArg = value(args, "--contract");
  const contractPath = contractArg ? resolve(roots.repoRoot, contractArg) : null, format = value(args, "--format") || "text";
  if (!["text", "json", "summary"].includes(format)) { console.error(`Unknown check-diff format: ${format}`); return 1; }
  const quiet = format !== "text", runtime = loadPolicyRuntime(roots, { quiet });
  const { ajv, policy, contractSchema } = runtime;
  if (!runtime.ok) { if (!quiet) console.error("\nPolicy compilation failed; aborting enforcement."); return 1; }
  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
  if (!enforcement.ok) { console.error(`ERROR: ${enforcement.message}`); return 1; }

  let contract = null;
  const initialChecks = [];
  if (contractPath) try {
    const loaded = loadJSON(contractPath), check = validationCheck(ajv, contractSchema, loaded, contractPath);
    initialChecks.push({ name: "change-contract", check });
    if (check.ok) contract = loaded;
  } catch (error) { initialChecks.push({ name: "change-contract", check: { ok: false, message: `Cannot read ${contractPath}: ${error.message}` } }); }

  let diffText;
  try { diffText = getDiff(base, head, roots.repoRoot); }
  catch (error) { console.error(`Error: ${error.message}`); return 1; }
  const report = runPolicyPipeline({ mode: "check-diff", repositoryRoot: roots.repoRoot, policy, contract, contractSource: contractPath ? "cli file" : "none", enforcement, diffText, initialChecks }, { quiet });
  const output = renderAnalysisReport(report, { format });
  if (output) console.log(output);
  return report.exitCode;
}
