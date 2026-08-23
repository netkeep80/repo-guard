const SHA = /^[0-9a-f]{40}$/i;
const REPO_GUARD = /(?:^|\/)repo-guard(?:@|$)/i;
const PROJECT_EXECUTION = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:ci|install|test|run\s+build|build)|(?:^|\s)(?:make|mvn|gradle|cargo)\s+(?:test|build|check)(?:\s|$)/im;
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function array(value) {
    return Array.isArray(value) ? value : [];
}
function stringArray(value) {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0))
        return null;
    return [...new Set(value)].sort();
}
function truthy(value) {
    return ![undefined, null, false, 0, "", "false", "0", "null"].includes(value);
}
function workflows(input) {
    if (!isObject(input))
        return [];
    const integration = input;
    return array(integration.workflows).filter(isObject);
}
function workflowPath(workflow) {
    return typeof workflow?.path === "string" && workflow.path.length > 0 ? workflow.path : null;
}
function hasEvent(workflow, event) {
    return array(workflow.triggerEvents).includes(event);
}
function hasEventType(workflow, event, type) {
    return array(workflow.triggerEventTypes).some((fact) => {
        if (!isObject(fact))
            return false;
        const typed = fact;
        return typed.event === event && array(typed.types).includes(type);
    });
}
function repoGuardActions(workflow) {
    return array(workflow.actionUses)
        .filter(isObject)
        .map((fact) => fact.uses)
        .filter((uses) => typeof uses === "string" && (uses === "./" || uses.startsWith("./") || REPO_GUARD.test(uses)));
}
function externalActionIsImmutable(uses) {
    if (uses === "./" || uses.startsWith("./"))
        return true;
    const at = uses.lastIndexOf("@");
    return at > 0 && SHA.test(uses.slice(at + 1));
}
function hasBlockingMode(workflow, mode) {
    const expected = workflow.expect;
    if (expected?.mode !== mode || expected?.enforcement !== "blocking")
        return false;
    return array(workflow.stepInputs).filter(isObject).some((fact) => {
        const inputs = fact.inputs;
        return inputs?.mode === mode && inputs?.enforcement === "blocking";
    });
}
function hasContinueOnError(workflow) {
    return array(workflow.continueOnError).filter(isObject).some((fact) => truthy(fact.value));
}
function hasCheckout(workflow) {
    return array(workflow.actionUses).filter(isObject).some((fact) => {
        const uses = fact.uses;
        return typeof uses === "string" && uses.toLowerCase().startsWith("actions/checkout@");
    });
}
function hasProjectExecution(workflow) {
    return array(workflow.runCommands).filter(isObject).some((fact) => PROJECT_EXECUTION.test(String(fact.run ?? "")));
}
function add(blockers, id, source, message, hint) {
    if (blockers.some((item) => item.id === id))
        return;
    blockers.push({ id, source, message, ...(hint === undefined ? {} : { hint }) });
}
function checkActionPin(workflow, blockers) {
    const actions = repoGuardActions(workflow);
    if (actions.length === 0) {
        add(blockers, "missing_repo_guard_action", "repository", "workflow has no repo-guard Action invocation");
        return;
    }
    if (actions.some((uses) => !externalActionIsImmutable(uses))) {
        add(blockers, "mutable_action_ref", "repository", "external repo-guard Action ref must be an exact commit SHA");
    }
}
function checkTransaction(workflow, blockers) {
    if (!workflow) {
        add(blockers, "missing_transaction_gate", "repository", "blocking pull-request transaction gate is missing");
        return;
    }
    if (!hasEvent(workflow, "pull_request"))
        add(blockers, "missing_pull_request_event", "repository", "transaction gate must listen to pull_request");
    if (!hasBlockingMode(workflow, "check-pr"))
        add(blockers, "transaction_gate_not_blocking", "repository", "transaction gate must run blocking check-pr");
    if (hasContinueOnError(workflow))
        add(blockers, "transaction_gate_continue_on_error", "repository", "transaction gate must not continue on error");
    checkActionPin(workflow, blockers);
}
function checkControlPlane(provider, input, blockers) {
    const facts = isObject(input) ? input : {};
    const targetBranch = typeof facts.targetBranch === "string" && facts.targetBranch.length > 0 ? facts.targetBranch : null;
    const requiredChecks = stringArray(facts.requiredChecks);
    if (!targetBranch)
        add(blockers, "unknown_target_branch", "control_plane", "target branch must be known exactly");
    if (!requiredChecks)
        add(blockers, "unknown_required_checks", "control_plane", "required check names must be known and non-empty");
    if (facts.pullRequestRequired === null || facts.pullRequestRequired === undefined)
        add(blockers, "unknown_pull_request_requirement", "control_plane", "pull-request requirement is unknown");
    else if (facts.pullRequestRequired !== true)
        add(blockers, "pull_request_not_required", "control_plane", "target branch must require pull requests");
    if (facts.requiredChecksEnforced === null || facts.requiredChecksEnforced === undefined)
        add(blockers, "unknown_required_checks_enforcement", "control_plane", "required-check enforcement is unknown");
    else if (facts.requiredChecksEnforced !== true)
        add(blockers, "required_checks_not_enforced", "control_plane", "required checks must be enforced");
    if (facts.noBypass === null || facts.noBypass === undefined)
        add(blockers, "unknown_bypass_state", "control_plane", "effective bypass state is unknown");
    else if (facts.noBypass !== true)
        add(blockers, "bypass_enabled", "control_plane", "integration path must not rely on a protection bypass");
    if (provider === "portable") {
        if (facts.upToDateRequired === null || facts.upToDateRequired === undefined)
            add(blockers, "unknown_up_to_date_requirement", "control_plane", "up-to-date branch requirement is unknown");
        else if (facts.upToDateRequired !== true)
            add(blockers, "branch_not_required_up_to_date", "control_plane", "portable integration requires up-to-date protection");
    }
    else {
        if (facts.mergeQueueEnabled === null || facts.mergeQueueEnabled === undefined)
            add(blockers, "unknown_merge_queue_capability", "control_plane", "merge queue capability is unknown");
        else if (facts.mergeQueueEnabled !== true)
            add(blockers, "merge_queue_unavailable", "control_plane", "GitHub Merge Queue must be enabled for the selected provider");
    }
    return { targetBranch, requiredChecks };
}
function checkNative(workflow, blockers) {
    if (!workflow) {
        add(blockers, "missing_native_state_gate", "repository", "native merge-group state gate is missing");
        return;
    }
    if (!hasEvent(workflow, "merge_group"))
        add(blockers, "missing_merge_group_event", "repository", "native state gate must listen to merge_group");
    if (!hasEventType(workflow, "merge_group", "checks_requested"))
        add(blockers, "missing_checks_requested", "repository", "merge_group gate must handle checks_requested");
    if (!hasBlockingMode(workflow, "check-merge-group"))
        add(blockers, "native_state_not_blocking", "repository", "native state gate must run blocking check-merge-group");
    if (hasContinueOnError(workflow))
        add(blockers, "native_state_continue_on_error", "repository", "native state gate must not continue on error");
    checkActionPin(workflow, blockers);
}
function checkPortable(transaction, workflow, blockers) {
    if (!workflow) {
        add(blockers, "missing_portable_coordinator", "repository", "portable coordinator workflow is missing");
        return;
    }
    if (workflowPath(transaction) !== null && workflowPath(transaction) === workflowPath(workflow)) {
        add(blockers, "coordinator_shares_transaction_workflow", "repository", "privileged coordinator must be separated from the PR transaction workflow");
    }
    if (!hasBlockingMode(workflow, "portable-coordinator"))
        add(blockers, "coordinator_not_blocking", "repository", "portable coordinator must use its blocking trusted mode");
    if (hasContinueOnError(workflow))
        add(blockers, "coordinator_continue_on_error", "repository", "portable coordinator must not continue on error");
    if (hasCheckout(workflow))
        add(blockers, "coordinator_checkout_forbidden", "repository", "privileged coordinator must not checkout repository content");
    if (hasProjectExecution(workflow))
        add(blockers, "coordinator_project_execution_forbidden", "repository", "privileged coordinator must not execute project build or test commands");
    checkActionPin(workflow, blockers);
}
export function evaluateParallelReadiness(input) {
    const blockers = [];
    const all = workflows(input.integrationFacts);
    const transaction = all.find((workflow) => workflow.role === "repo_guard_pr_gate");
    const providerWorkflow = input.provider === "portable"
        ? all.find((workflow) => workflow.role === "repo_guard_portable_coordinator")
        : all.find((workflow) => workflow.role === "repo_guard_merge_group_gate");
    const hasNativeProvider = all.some((workflow) => workflow.role === "repo_guard_merge_group_gate");
    const hasPortableProvider = all.some((workflow) => workflow.role === "repo_guard_portable_coordinator");
    if (!isObject(input.integrationFacts))
        add(blockers, "invalid_integration_facts", "repository", "integration facts must be an object");
    else if (array(input.integrationFacts.errors).length > 0)
        add(blockers, "integration_extraction_failed", "repository", "integration extraction contains errors");
    if (hasNativeProvider && hasPortableProvider)
        add(blockers, "provider_role_conflict", "repository", "parallel provider roles must not declare both native merge-group gate and portable coordinator");
    checkTransaction(transaction, blockers);
    if (input.provider === "portable")
        checkPortable(transaction, providerWorkflow, blockers);
    else
        checkNative(providerWorkflow, blockers);
    const control = checkControlPlane(input.provider, input.controlPlaneFacts, blockers);
    blockers.sort((left, right) => left.id.localeCompare(right.id));
    return {
        provider: input.provider,
        ready: blockers.length === 0,
        blockers,
        evidence: {
            repository: {
                transactionWorkflow: workflowPath(transaction),
                providerWorkflow: workflowPath(providerWorkflow),
            },
            control_plane: control,
        },
    };
}
