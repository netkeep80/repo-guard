import { resolve } from "node:path";
import { getDiff } from "./git.mjs";
import { warnReservedContractFields } from "./policy-compiler.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { renderAnalysisReport } from "./reporting/renderers.mjs";
import { loadJSON, loadPolicyRuntime, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";

const CHECK_DIFF_USAGE = "Usage: repo-guard check-diff [--base <ref>] [--head <ref>] [--contract <path>] [--format <text|json|summary>] [--enforcement <advisory|blocking>]";
const FORMATS = new Set(["text", "json", "summary"]);
const OPTIONS = new Set(["--base", "--head", "--contract", "--format"]);

function parseCheckDiffArgs(roots, args) {
  const result = { ok: true, base: null, head: null, contractPath: null, format: "text" };
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    if (option.startsWith("-") && !OPTIONS.has(option)) return { ok: false, message: `Unknown option for check-diff: ${option}` };
    if (!OPTIONS.has(option) || !value) continue;
    if (option === "--base") result.base = value;
    else if (option === "--head") result.head = value;
    else if (option === "--contract") result.contractPath = resolve(roots.repoRoot, value);
    else result.format = value;
    i++;
  }
  if (!FORMATS.has(result.format)) return { ok: false, message: `Unknown check-diff format: ${result.format}` };
  return result;
}

export function runCheckDiff(roots, args) {
  const parsed = parseCheckDiffArgs(roots, args);
  if (!parsed.ok) {
    console.error(`${parsed.message}\n${CHECK_DIFF_USAGE}`);
    return 1;
  }

  const quiet = parsed.format !== "text";
  const runtime = loadPolicyRuntime(roots, { quiet });
  const { ajv, policy, contractSchema } = runtime;
  if (!runtime.ok) {
    if (!quiet) console.error("\nPolicy compilation failed; aborting enforcement.");
    return 1;
  }

  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
  if (!enforcement.ok) {
    console.error(`ERROR: ${enforcement.message}`);
    return 1;
  }

  let contract = null;
  const initialChecks = [];
  if (parsed.contractPath) {
    try {
      const loaded = loadJSON(parsed.contractPath);
      const check = validationCheck(ajv, contractSchema, loaded, parsed.contractPath);
      initialChecks.push({ name: "change-contract", check });
      if (check.ok) {
        contract = loaded;
        if (!quiet) for (const warning of warnReservedContractFields(contract)) console.warn(`WARN: ${warning}`);
      }
    } catch (error) {
      initialChecks.push({ name: "change-contract", check: { ok: false, message: `Cannot read ${parsed.contractPath}: ${error.message}` } });
    }
  }

  let diffText;
  try {
    diffText = getDiff(parsed.base, parsed.head, roots.repoRoot);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }

  const report = runPolicyPipeline({
    mode: "check-diff",
    repositoryRoot: roots.repoRoot,
    policy,
    contract,
    contractSource: parsed.contractPath ? "cli file" : "none",
    enforcement,
    diffText,
    initialChecks,
  }, { quiet });
  const output = renderAnalysisReport(report, { format: parsed.format });
  if (output) console.log(output);
  return report.exitCode;
}
