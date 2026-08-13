import { resolve } from "node:path";
import { integrationConstraintEntries } from "./checks/integration-constraints.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { extractIntegration } from "./extractors/integration.mjs";
import { compileIntegrationPolicy } from "./policy-compiler.mjs";
import { createAnalysisTextPresenter, renderAnalysisReport } from "./reporting/renderers.mjs";
import { createAnalysisCollector } from "./runtime/analysis-report.mjs";
import { ajvErrors, createAjv, loadJSON } from "./runtime/validation.mjs";
const emptyFacts = () => ({ workflows: [], templates: [], docs: [], profiles: [], errors: [] });
const count = (integration = {}) => {
    const result = Object.fromEntries(["workflows", "templates", "docs", "profiles"].map((key) => [key, Array.isArray(integration[key]) ? integration[key].length : 0]));
    return { ...result, ...(Array.isArray(integration.errors) ? { errors: integration.errors.length } : {}), total: result.workflows + result.templates + result.docs + result.profiles };
};
const option = (args, name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
export function createIntegrationAnalysisReport(roots, { format = "text" } = {}) {
    const policyPath = resolve(roots.repoRoot, "repo-policy.json"), schemaPath = resolve(roots.packageRoot, "schemas/repo-policy.schema.json");
    let policy, schema;
    try {
        policy = loadJSON(policyPath);
    }
    catch (error) {
        const enforcement = { mode: roots.enforcementMode || "blocking" };
        const reporter = createAnalysisCollector(enforcement, { presenter: format === "text" ? createAnalysisTextPresenter() : null });
        reporter.report("repo-policy.json", { ok: false, message: `Cannot read ${policyPath}: ${error.message}`, hint: "Create a valid repo-policy.json before validating integration wiring" });
        return reporter.finish({ command: "validate-integration", repositoryRoot: roots.repoRoot, integration: emptyFacts(), diagnostics: { declared: count(), extracted: count(emptyFacts()), artifactErrors: [] } });
    }
    try {
        schema = loadJSON(schemaPath);
    }
    catch (error) {
        return { fatal: true, message: `ERROR: Cannot read ${schemaPath}: ${error.message}` };
    }
    const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
    if (!enforcement.ok)
        return { fatal: true, message: `ERROR: ${enforcement.message}` };
    const quiet = format !== "text";
    if (!quiet)
        console.log("repo-guard validate-integration\n");
    const reporter = createAnalysisCollector(enforcement, { presenter: quiet ? null : createAnalysisTextPresenter() });
    const ajv = createAjv(), schemaOk = ajv.validate(schema, policy);
    reporter.report("repo-policy.json", schemaOk
        ? { ok: true, message: "repo-policy.json is valid JSON policy" }
        : { ok: false, message: "repo-policy.json failed schema validation", errors: ajvErrors(ajv.errors), hint: "Fix policy schema errors before relying on integration diagnostics" });
    const declared = count(policy.integration), compileErrors = schemaOk ? compileIntegrationPolicy(policy) : [];
    if (!policy.integration)
        reporter.report("integration-policy", { ok: false, message: "repo-policy.json has no integration section", hint: "Declare integration.workflows, integration.templates, integration.docs, or integration.profiles" });
    else if (!declared.total)
        reporter.report("integration-policy", { ok: false, message: "integration section declares no artifacts", hint: "Declare at least one integration workflow, template, doc, or profile" });
    else if (compileErrors.length)
        reporter.report("integration-policy", { ok: false, message: "Integration policy failed compilation", details: compileErrors.map((error) => error.message), hint: "Fix integration ids and profile references" });
    else
        reporter.report("integration-policy", { ok: true, message: "Integration policy compiles" });
    let integration = emptyFacts();
    if (policy.integration && schemaOk && !compileErrors.length) {
        integration = extractIntegration(policy, { repoRoot: roots.repoRoot });
        for (const entry of integrationConstraintEntries(integration))
            reporter.report(entry.name, entry.check);
    }
    const diagnostics = {
        declared,
        extracted: count(integration),
        artifactErrors: integration.errors.map((error) => `${error.section}${error.id ? `:${error.id}` : ""}${error.path ? ` (${error.path})` : ""}: ${error.message}`),
    };
    return reporter.finish({ command: "validate-integration", repositoryRoot: roots.repoRoot, integration, diagnostics });
}
export function runValidateIntegration(roots, args = []) {
    const format = option(args, "--format", "text");
    if (!["text", "json", "summary"].includes(format)) {
        console.error(`Unknown validate-integration format: ${format}`);
        return 1;
    }
    const report = createIntegrationAnalysisReport(roots, { format });
    if (report.fatal) {
        console.error(report.message);
        return 1;
    }
    const output = renderAnalysisReport(report, { format });
    if (output)
        console.log(output);
    return report.exitCode;
}
