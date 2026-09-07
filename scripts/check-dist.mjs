#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBuild, repositoryRoot } from "./build.mjs";

function git(args, options = {}) {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf-8", ...options });
}

export function checkDistFreshness() {
  cleanBuild();

  const diff = git(["diff", "--exit-code", "--", "dist"], { stdio: "inherit" });
  if (diff.error) throw diff.error;

  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "dist"]);
  if (untracked.error) throw untracked.error;
  if (untracked.status !== 0) {
    process.stderr.write(untracked.stderr || "failed to inspect generated dist files\n");
    process.exit(untracked.status ?? 1);
  }

  const untrackedFiles = untracked.stdout.split(/\r?\n/).filter(Boolean);
  if (diff.status !== 0 || untrackedFiles.length) {
    if (untrackedFiles.length) {
      console.error("Generated dist contains untracked files:");
      for (const path of untrackedFiles) console.error(`  ${path}`);
    }
    console.error("Generated dist is stale. Run npm run build and commit the exact dist output.");
    process.exit(diff.status && diff.status > 1 ? diff.status : 1);
  }

  console.log("Generated dist is current.");
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) checkDistFreshness();
