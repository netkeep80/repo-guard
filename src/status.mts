import {
  projectAgentLifecycle,
  type AgentLifecycleProjection,
} from "./agent-lifecycle.mjs";

const value = (args: string[], name: string): string | null | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};

function renderText(status: AgentLifecycleProjection): string {
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

export function runStatus(_roots: unknown, args: string[] = []): number {
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

  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch (error: unknown) {
    console.error(`ERROR: invalid status JSON: ${(error as Error).message}`);
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
