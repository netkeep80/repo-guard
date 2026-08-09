#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const MODES = new Set(["check-diff", "check-pr", "init", "doctor", "validate-integration"]);
const USAGE = "Usage: repo-guard [--repo-root <path>] [--enforcement <advisory|blocking>] [check-diff|check-pr|init|doctor|validate-integration] [options]";

export function resolveRoots(args) {
  let repoRoot = process.cwd();
  let enforcementMode = null;
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root" || args[i] === "--enforcement" || args[i] === "--enforcement-mode") {
      const option = args[i];
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`${option} requires an argument\n${USAGE}`);
      }
      if (option === "--repo-root") repoRoot = resolve(next);
      else enforcementMode = next;
      i++;
    } else {
      filtered.push(args[i]);
    }
  }
  return { packageRoot, repoRoot, enforcementMode, args: filtered };
}

function sameEntrypointPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

async function dispatch(roots) {
  const command = roots.args.shift();
  if (command?.startsWith("-") && !MODES.has(command)) {
    throw new Error(`Unknown option: ${command}\n${USAGE}`);
  }

  if (command === "check-diff") {
    const { runCheckDiff } = await import("./check-diff.mjs");
    return runCheckDiff(roots, roots.args);
  }
  if (command === "check-pr") {
    const { runCheckPR } = await import("./github-pr.mjs");
    return runCheckPR(roots, roots.args);
  }
  if (command === "init") {
    const { runInit } = await import("./init.mjs");
    return runInit(roots, roots.args);
  }
  if (command === "doctor" && !roots.args.includes("--integration")) {
    const { runDoctor } = await import("./doctor.mjs");
    return runDoctor(roots).fails > 0 ? 1 : 0;
  }
  if (command === "doctor" || command === "validate-integration") {
    const { runValidateIntegration } = await import("./integration-validator.mjs");
    return runValidateIntegration(roots, roots.args);
  }
  const { runValidate } = await import("./validate.mjs");
  return runValidate(roots, command ? [command, ...roots.args] : roots.args);
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    return await dispatch(resolveRoots([...args]));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && sameEntrypointPath(process.argv[1], resolve(__dirname, "repo-guard.mjs"));
if (isMain) process.exit(await runCli());
