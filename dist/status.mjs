import { projectAgentLifecycle } from "./agent-lifecycle.mjs";
const value = (args, name) => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
};
function renderText(status) {
    return [
        status.state.toUpperCase(),
        `Protocol: ${status.protocol}`,
        `Provider: ${status.provider}`,
        `PR: #${status.pr}`,
        `Base SHA: ${status.base_sha}`,
        `Head SHA: ${status.head_sha}`,
        `Branch behind: ${status.branch_behind ? "yes" : "no"}`,
        `Agent branch update: ${status.requires_agent_branch_update ? "required" : "not required"}`,
        `Next action: ${status.next_action}`,
    ].join("\n");
}
export function runStatus(_roots, args = []) {
    const format = value(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") {
        console.error(`ERROR: unsupported status format: ${format}`);
        return 1;
    }
    const rawInput = value(args, "--input");
    if (!rawInput) {
        console.error("ERROR: status requires --input with normalized lifecycle facts");
        return 1;
    }
    let input;
    try {
        input = JSON.parse(rawInput);
    }
    catch (error) {
        console.error(`ERROR: invalid status JSON: ${error.message}`);
        return 1;
    }
    const result = projectAgentLifecycle(input);
    if (!result.ok) {
        console.error(`ERROR: [${result.error}] ${result.message}`);
        return 1;
    }
    console.log(format === "json" ? JSON.stringify(result.value) : renderText(result.value));
    return 0;
}
