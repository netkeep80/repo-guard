import { compareSets } from "./relation-kernel.mjs";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const lower = (value) => String(value || "").toLowerCase();
const localUse = (uses) => { const value = String(uses || ""); return value === "./" || value.startsWith("./") || value.startsWith("../"); };
function actionUse(uses) {
    const raw = String(uses || "").trim();
    if (localUse(raw))
        return { raw, target: raw, ref: "", local: true };
    const at = raw.lastIndexOf("@");
    return at < 0 ? { raw, target: raw, ref: "", local: false } : { raw, target: raw.slice(0, at), ref: raw.slice(at + 1), local: false };
}
const repoGuardUse = (uses) => { const parsed = actionUse(uses); return parsed.local || lower(parsed.target).includes("repo-guard"); };
const semver = (ref) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(ref || ""));
const sha = (ref) => /^[0-9a-f]{40}$/i.test(String(ref || ""));
const branch = (ref) => /^(main|master|develop|dev|trunk|head)$/i.test(String(ref || ""));
function pinned(use, strategy = "ref") {
    if (strategy === "any")
        return true;
    if (strategy === "local")
        return use.local;
    if (use.local)
        return true;
    if (strategy === "sha")
        return sha(use.ref);
    if (strategy === "semver")
        return semver(use.ref);
    if (strategy === "tag")
        return use.ref.length > 0 && !sha(use.ref) && !branch(use.ref);
    return use.ref.length > 0;
}
const stepInputs = (workflow, action) => workflow.stepInputs.find((fact) => fact.jobId === action.jobId && fact.stepIndex === action.stepIndex && fact.uses === action.uses)?.inputs || {};
const repoGuardActions = (workflow, expected = {}) => workflow.actionUses.map((fact) => ({ ...fact, parsed: actionUse(fact.uses) })).filter((fact) => expected.uses ? fact.parsed.target === expected.uses || fact.uses === expected.uses : repoGuardUse(fact.uses));
const referencesRepoGuard = (workflow) => workflow.actionUses.some((fact) => repoGuardUse(fact.uses)) || workflow.runCommands.some((fact) => /repo-guard|src\/repo-guard\.mjs/i.test(String(fact.run || "")));
const hasFetchDepthZero = (workflow) => workflow.stepInputs.some((fact) => lower(fact.uses).startsWith("actions/checkout") && fact.inputs?.["fetch-depth"] === "0");
const hasEnv = (workflow, names) => { const actual = new Set(workflow.envVars.map((fact) => fact.name)); return names.some((name) => actual.has(name)); };
const hasAllEnv = (workflow, names) => { const actual = new Set(workflow.envVars.map((fact) => fact.name)); return names.every((name) => actual.has(name)); };
function hasPermission(workflow, name, expected) {
    const matches = (value) => value && lower(value) === lower(expected);
    if (matches(object(workflow.permissions.workflow)[name]))
        return true;
    return workflow.permissions.jobs.some((job) => matches(object(job.permissions)[name]));
}
const location = (workflow, fact = {}) => {
    const parts = [];
    if (fact.jobId)
        parts.push(`job ${fact.jobId}`);
    if (fact.stepIndex)
        parts.push(`step ${fact.stepIndex}${fact.stepName ? ` "${fact.stepName}"` : ""}`);
    return parts.length ? `${workflow.path}: ${parts.join(" ")}` : workflow.path;
};
const detail = (workflow, fact, message) => `${location(workflow, fact)}: ${message}`;
const truthy = (value) => !["", "false", "0", "null"].includes(lower(value).trim());
const manualClone = (run) => /\bgit\s+clone\b/i.test(String(run || "")) && /repo-guard/i.test(String(run || ""));
const tempCli = (run) => String(run || "").split(/\r?\n/).some((line) => /RUNNER_TEMP|TMPDIR|\/tmp|\btemp\b/i.test(line) && /src\/repo-guard\.mjs|repo-guard\.mjs/i.test(line));
function workflowDetails(workflow) {
    const details = [], expect = workflow.expect || {};
    if (workflow.role !== "repo_guard_pr_gate") {
        if (!referencesRepoGuard(workflow))
            details.push(`${workflow.path}: workflow does not reference repo-guard via uses or run`);
        return details;
    }
    const events = expect.events?.length ? expect.events : ["pull_request"];
    for (const event of compareSets(events, workflow.triggerEvents, "left_subset").missing)
        details.push(`${workflow.path}: repo_guard_pr_gate workflow missing required event ${event}`);
    if (!expect.events?.length && !workflow.triggerEvents.includes("pull_request") && !workflow.triggerEvents.includes("pull_request_target")) {
        details.push(`${workflow.path}: repo_guard_pr_gate workflow must run on pull_request or pull_request_target`);
    }
    if (expect.event_types?.length) {
        const event = workflow.triggerEvents.includes("pull_request") ? "pull_request" : "pull_request_target";
        const actual = workflow.triggerEventTypes.find((fact) => fact.event === event)?.types || [];
        for (const type of compareSets(expect.event_types, actual, "left_subset").missing)
            details.push(`${workflow.path}: repo_guard_pr_gate workflow missing required ${event} type ${type}`);
    }
    if (!hasFetchDepthZero(workflow))
        details.push(`${workflow.path}: repo_guard_pr_gate workflow should checkout with fetch-depth: 0`);
    const actions = repoGuardActions(workflow, expect.action || {});
    if (expect.action && !actions.length)
        details.push(`${workflow.path}: repo_guard_pr_gate workflow must use ${expect.action.uses || "a repo-guard action"} via uses`);
    if (!expect.action && !referencesRepoGuard(workflow))
        details.push(`${workflow.path}: workflow does not reference repo-guard via uses or run`);
    if (actions.length && expect.action) {
        const strategy = expect.action.ref_pinning || "ref";
        if (!actions.some((fact) => (!expect.action.ref || fact.parsed.ref === expect.action.ref) && pinned(fact.parsed, strategy))) {
            details.push(`${workflow.path}: repo_guard_pr_gate action must satisfy ref_pinning ${strategy}${expect.action.ref ? ` at ref ${expect.action.ref}` : ""}; actual uses: ${actions.map((fact) => fact.uses).join(", ")}`);
        }
    }
    const mode = expect.mode || "check-pr";
    for (const [field, wanted] of [["mode", mode], ["enforcement", expect.enforcement]]) {
        if (wanted && actions.length && !actions.some((fact) => stepInputs(workflow, fact)[field] === wanted))
            details.push(detail(workflow, actions[0], `repo_guard_pr_gate action must set ${field}: ${wanted}`));
    }
    if (!actions.length && mode === "check-pr" && !workflow.runCommands.some((fact) => String(fact.run || "").includes("check-pr")))
        details.push(`${workflow.path}: repo_guard_pr_gate workflow must run check-pr`);
    for (const [permission, wanted] of Object.entries(expect.permissions || {}))
        if (!hasPermission(workflow, permission, wanted))
            details.push(`${workflow.path}: repo_guard_pr_gate workflow must declare permission ${permission}: ${wanted}`);
    const tokenEnv = expect.token_env || (mode === "check-pr" ? ["GH_TOKEN", "GITHUB_TOKEN"] : []);
    if (tokenEnv.length && !hasEnv(workflow, tokenEnv))
        details.push(`${workflow.path}: check-pr workflow should provide one of ${tokenEnv.join(", ")}`);
    if (expect.required_env?.length && !hasAllEnv(workflow, expect.required_env)) {
        const actual = new Set(workflow.envVars.map((fact) => fact.name));
        details.push(`${workflow.path}: repo_guard_pr_gate workflow missing required env ${expect.required_env.filter((name) => !actual.has(name)).join(", ")}`);
    }
    if (expect.summary === true && !workflow.summaryPublishing.length)
        details.push(`${workflow.path}: repo_guard_pr_gate workflow must publish to GITHUB_STEP_SUMMARY`);
    const disallow = new Set(expect.disallow || ["continue_on_error", "manual_clone", "direct_temp_cli_execution"]);
    if (disallow.has("continue_on_error"))
        for (const fact of workflow.continueOnError || [])
            if (truthy(fact.value))
                details.push(detail(workflow, fact, "repo_guard_pr_gate step must not set continue-on-error"));
    if (disallow.has("manual_clone"))
        for (const fact of workflow.runCommands)
            if (manualClone(fact.run))
                details.push(detail(workflow, fact, "repo_guard_pr_gate workflow must not clone repo-guard manually"));
    if (disallow.has("direct_temp_cli_execution"))
        for (const fact of workflow.runCommands)
            if (tempCli(fact.run))
                details.push(detail(workflow, fact, "repo_guard_pr_gate workflow must not run repo-guard directly from a temporary clone"));
    return details;
}
function templateDetails(template) {
    if (template.present === false && template.optional)
        return [];
    const details = [], blocks = template.changeIntentBlocks || [];
    const selected = template.requiredBlockKind ? blocks.filter((block) => block.format === template.requiredBlockKind) : blocks;
    if (template.requiredBlockKind && !selected.length)
        details.push(`${template.path}: ${template.id} requires a ${template.requiredBlockKind} fenced ChangeIntent block`);
    else if (template.requiresChangeIntentBlock && !template.hasRepoGuardYamlBlock && !template.hasRepoGuardJsonBlock)
        details.push(`${template.path}: ${template.id} requires a repo-guard ChangeIntent block`);
    const fields = new Set(selected.flatMap((block) => block.fieldPaths || []));
    for (const field of template.requiredChangeIntentFields || [])
        if (!fields.has(field))
            details.push(`${template.path}: ${template.id} ChangeIntent block missing required field "${field}"`);
    return details;
}
function missingMentions(doc, facts, label) {
    return (facts || []).filter((mention) => !mention.present).map((mention) => `${doc.path}: missing required ${label} "${mention.term}"`);
}
export function integrationConstraintEntries(integration = {}) {
    const artifacts = array(integration.errors).map((error) => `${error.section}${error.id ? `:${error.id}` : ""}${error.path ? ` (${error.path})` : ""}: ${error.message}`);
    const workflows = array(integration.workflows).flatMap(workflowDetails);
    const templates = array(integration.templates).flatMap(templateDetails);
    const docs = array(integration.docs).flatMap((doc) => [
        ...missingMentions(doc, doc.mentions, "mention"), ...missingMentions(doc, doc.fileReferences, "file reference"),
        ...missingMentions(doc, doc.profileMentions, "profile mention"), ...missingMentions(doc, doc.changeIntentFieldMentions, "ChangeIntent field mention"),
    ]);
    const profiles = array(integration.profiles).flatMap((profile) => profile.profileNameReferences?.length ? [] : [`${profile.docPath}: profile "${profile.id}" is not mentioned`]);
    const entry = (name, details, pass, fail, hint) => ({ name, check: details.length ? { ok: false, message: fail, details, hint } : { ok: true, message: pass } });
    return [
        entry("integration-artifacts", artifacts, "All declared integration artifacts were read and parsed", "Integration artifact extraction failed", "Fix missing files, malformed workflow YAML, malformed ChangeIntent blocks, or Markdown fences"),
        entry("integration-workflows", workflows, "Workflow integration wiring is valid", "Workflow integration wiring has issues", "Compare declared repo-guard workflows with templates/example-workflow.yml"),
        entry("integration-templates", templates, "Template integration wiring is valid", "Template integration wiring has issues", "Add repo-guard-yaml or repo-guard-json fenced ChangeIntent blocks to required templates"),
        entry("integration-docs", docs, "Documentation integration wiring is valid", "Documentation integration wiring has issues", "Update declared docs so every must_mention term appears"),
        entry("integration-profiles", profiles, "Profile documentation wiring is valid", "Profile documentation wiring has issues", "Mention each integration profile id in its declared profile document"),
    ];
}
