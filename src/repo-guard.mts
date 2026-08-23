#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface CliRoots {
  packageRoot: string;
  repoRoot: string;
  enforcementMode: string | null;
  args: string[];
}

interface CommandSpec {
  options: Record<string, boolean>;
  positionals: number;
  run: (roots: CliRoots, args: string[]) => number | Promise<number>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const valueOptions = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map((name) => [name, true]));

const COMMAND_SPECS: Record<string, CommandSpec> = {
  validate: {
    options: {}, positionals: 1,
    run: async (roots, args) => (await import("./validate.mjs")).runValidate(roots, args),
  },
  "check-diff": {
    options: valueOptions("--base", "--head", "--change-intent", "--format"), positionals: 0,
    run: async (roots, args) => (await import("./check-diff.mjs")).runCheckDiff(roots, args),
  },
  "check-pr": {
    options: {}, positionals: 0,
    run: async (roots, args) => (await import("./github-pr.mjs")).runCheckPR(roots, args),
  },
  "check-merge-group": {
    options: valueOptions("--format"), positionals: 0,
    run: async (roots, args) => (await import("./github-merge-group.mjs")).runCheckMergeGroup(roots, args),
  },
  init: {
    options: { ...valueOptions("--preset", "--mode", "--action-ref"), "--help": false }, positionals: 0,
    run: async (roots, args) => (await import("./init.mjs")).runInit(roots, args),
  },
  doctor: {
    options: { "--integration": false, ...valueOptions("--format") }, positionals: 0,
    run: async (roots, args) => args.includes("--integration")
      ? (await import("./integration-validator.mjs")).runValidateIntegration(roots, args)
      : ((await import("./doctor.mjs")).runDoctor(roots).fails > 0 ? 1 : 0),
  },
  "validate-integration": {
    options: valueOptions("--format"), positionals: 0,
    run: async (roots, args) => (await import("./integration-validator.mjs")).runValidateIntegration(roots, args),
  },
};

export const COMMANDS = Object.freeze(Object.keys(COMMAND_SPECS));
const USAGE = `Usage: repo-guard [--repo-root <path>] [--enforcement <advisory|blocking>] [${COMMANDS.join("|")}] [options]`;

export function resolveRoots(args: string[]): CliRoots {
  let repoRoot = process.cwd(), enforcementMode: string | null = null;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!["--repo-root", "--enforcement", "--enforcement-mode"].includes(option)) { filtered.push(option); continue; }
    const next = args[++i];
    if (!next || next.startsWith("-")) throw new Error(`${option} requires ${option === "--repo-root" ? "a path" : "a mode"} argument\n${USAGE}`);
    if (option === "--repo-root") repoRoot = resolve(next); else enforcementMode = next;
  }
  return { packageRoot, repoRoot, enforcementMode, args: filtered };
}

function parseCommand(args: string[]) {
  const remaining = [...args];
  const first = remaining[0];
  const command = COMMAND_SPECS[first as string] ? remaining.shift() as string : "validate";
  if (first?.startsWith("-") && command === "validate") throw new Error(`Unknown option: ${first}\n${USAGE}`);
  const spec = COMMAND_SPECS[command];
  let positionals = 0;
  for (let i = 0; i < remaining.length; i++) {
    const token = remaining[i];
    if (!token.startsWith("-")) { positionals++; continue; }
    if (!Object.hasOwn(spec.options, token)) throw new Error(`Unknown option for ${command}: ${token}\n${USAGE}`);
    if (!spec.options[token]) continue;
    const value = remaining[++i];
    if (!value || value.startsWith("-")) throw new Error(`${token} requires a value\n${USAGE}`);
  }
  if (positionals > spec.positionals) throw new Error(`Unexpected argument for ${command}\n${USAGE}`);
  return { command, args: remaining };
}

function sameEntrypointPath(left: string, right: string) {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return resolve(left) === resolve(right); }
}

async function dispatch(roots: CliRoots) {
  const parsed = parseCommand(roots.args);
  return COMMAND_SPECS[parsed.command].run(roots, parsed.args);
}

export async function runCli(args: string[] = process.argv.slice(2)) {
  try { return await dispatch(resolveRoots([...args])); }
  catch (error: unknown) { console.error(`ERROR: ${(error as Error).message}`); return 1; }
}

const isMain = process.argv[1] && sameEntrypointPath(process.argv[1], resolve(__dirname, "repo-guard.mjs"));
if (isMain) process.exit(await runCli());
