import { resolve } from "node:path";
import { getDiff } from "./git.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { renderAnalysisReport } from "./reporting/renderers.mjs";
import { loadJSON, loadPolicyRuntime, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";
const value = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
export function runCheckDiff(roots, args = []) {
    const base = value(args, "--base"), head = value(args, "--head"), changeIntentArg = value(args, "--change-intent");
    const changeIntentPath = changeIntentArg ? resolve(roots.repoRoot, changeIntentArg) : null, format = value(args, "--format") || "text";
    if (!["text", "json", "summary"].includes(format)) {
        console.error(`Unknown check-diff format: ${format}`);
        return 1;
    }
    const quiet = format !== "text", runtime = loadPolicyRuntime(roots, { quiet });
    const { ajv, policy, changeIntentSchema } = runtime;
    if (!runtime.ok) {
        if (!quiet)
            console.error("\nPolicy compilation failed; aborting enforcement.");
        return 1;
    }
    const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
    if (!enforcement.ok) {
        console.error(`ERROR: ${enforcement.message}`);
        return 1;
    }
    let changeIntent = null;
    const initialChecks = [];
    if (changeIntentPath)
        try {
            const loaded = loadJSON(changeIntentPath), check = validationCheck(ajv, changeIntentSchema, loaded, changeIntentPath);
            initialChecks.push({ name: "change-intent", check });
            if (check.ok)
                changeIntent = loaded;
        }
        catch (error) {
            initialChecks.push({ name: "change-intent", check: { ok: false, message: `Cannot read ${changeIntentPath}: ${error.message}` } });
        }
    let diffText;
    try {
        diffText = getDiff(base, head, roots.repoRoot);
    }
    catch (error) {
        console.error(`Error: ${error.message}`);
        return 1;
    }
    const report = runPolicyPipeline({ mode: "check-diff", repositoryRoot: roots.repoRoot, policy, baseRef: base ?? null, headRef: head ?? null, changeIntent, changeIntentSource: changeIntentPath ? "cli file" : "none", enforcement, diffText, initialChecks }, { quiet });
    const output = renderAnalysisReport(report, { format });
    if (output)
        console.log(output);
    return report.exitCode;
}
