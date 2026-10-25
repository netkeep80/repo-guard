#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url)), packageRoot = resolve(__dirname, "..");
const valueOptions = (...names) => Object.fromEntries(names.map((name) => [name, true]));
const COMMAND_SPECS = {
    check: { options: valueOptions("--base", "--head", "--format"), positionals: 0, run: async (roots, args) => (await import("./local-compiler.mjs")).runLocalCheck(roots, args) },
    build: { options: valueOptions("--base", "--head", "--outputs"), positionals: 0, run: async (roots, args) => (await import("./projection-materialize.mjs")).runProjectionBuild(roots, args) },
};
export const COMMANDS = Object.freeze(Object.keys(COMMAND_SPECS));
const USAGE = `Usage: repo-guard [--repo-root <path>] <${COMMANDS.join("|")}> [options]`;
export function resolveRoots(args) {
    let repoRoot = process.cwd();
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option !== "--repo-root") {
            filtered.push(option);
            continue;
        }
        const next = args[++i];
        if (!next || next.startsWith("-"))
            throw new Error(`--repo-root requires a path argument\n${USAGE}`);
        repoRoot = resolve(next);
    }
    return { packageRoot, repoRoot, args: filtered };
}
function parseCommand(args) {
    const remaining = [...args], first = remaining.shift();
    if (!first || !COMMAND_SPECS[first])
        throw new Error(`Expected command ${COMMANDS.join(" or ")}\n${USAGE}`);
    const command = first, spec = COMMAND_SPECS[command];
    let positionals = 0;
    for (let i = 0; i < remaining.length; i++) {
        const token = remaining[i];
        if (!token.startsWith("-")) {
            positionals++;
            continue;
        }
        if (!Object.hasOwn(spec.options, token))
            throw new Error(`Unknown option for ${command}: ${token}\n${USAGE}`);
        if (!spec.options[token])
            continue;
        const value = remaining[++i];
        if (!value || value.startsWith("-"))
            throw new Error(`${token} requires a value\n${USAGE}`);
    }
    if (positionals > spec.positionals)
        throw new Error(`Unexpected argument for ${command}\n${USAGE}`);
    return { command, args: remaining };
}
function sameEntrypointPath(left, right) {
    try {
        return realpathSync(left) === realpathSync(right);
    }
    catch {
        return resolve(left) === resolve(right);
    }
}
async function dispatch(roots) {
    const parsed = parseCommand(roots.args);
    return COMMAND_SPECS[parsed.command].run(roots, parsed.args);
}
export async function runCli(args = process.argv.slice(2)) {
    try {
        return await dispatch(resolveRoots([...args]));
    }
    catch (error) {
        console.error(`ERROR: ${error.message}`);
        return 1;
    }
}
const isMain = process.argv[1] && sameEntrypointPath(process.argv[1], resolve(__dirname, "repo-guard.mjs"));
if (isMain)
    process.exit(await runCli());
