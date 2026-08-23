import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/repo-guard.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(path) {
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

describe("strict TypeScript source cutover", () => {
  it("keeps the canonical editable runtime mts-only", () => {
    const sourceFiles = filesUnder(resolve(root, "src"));
    assert.ok(sourceFiles.length > 20);
    assert.deepEqual(sourceFiles.filter((path) => /\.(?:mjs|js)$/.test(path)), []);
    assert.equal(sourceFiles.every((path) => path.endsWith(".mts")), true);
  });

  it("removes the allowJs migration bridge from the compiler", () => {
    const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf-8"));
    assert.equal(Object.hasOwn(tsconfig.compilerOptions, "allowJs"), false);
    assert.equal(Object.hasOwn(tsconfig.compilerOptions, "checkJs"), false);
    assert.deepEqual(tsconfig.include, ["src/**/*.mts"]);
  });

  it("keeps the built CLI command inventory explicit", () => {
    assert.deepEqual(COMMANDS, ["validate", "check-diff", "check-pr", "check-merge-group", "status", "init", "migrate", "doctor", "portable-coordinator", "validate-integration"]);
  });

  it("keeps the privileged portable coordinator on the trusted execFile control-plane boundary", () => {
    const source = readFileSync(resolve(root, "src/portable-integration/public-command.mts"), "utf-8");

    assert.match(source, /import \{ execFileSync \} from "node:child_process";/);
    assert.match(source, /runTrustedPortableCoordinator\(\{/);
    assert.match(source, /run\("gh", \["api",/);

    assert.doesNotMatch(source, /\bexecSync\b/);
    assert.doesNotMatch(source, /\b(?:exec|spawn|spawnSync)\s*\(/);
    assert.doesNotMatch(source, /shell\s*:\s*true/);
    assert.doesNotMatch(source, /run\("git"/);
    assert.doesNotMatch(source, /git\s+(?:remote|merge|rebase|push)\b/);
    assert.doesNotMatch(source, /actions\/checkout/);
    assert.doesNotMatch(source, /npm\s+(?:test|run)\b/);
    assert.doesNotMatch(source, /\b(?:branch protection|ruleset|bypass|admin)\b/i);
    assert.doesNotMatch(source, /from\s+"\.\/portable-integration\/(?:planner|coordinator-loop)\.mjs"/);
  });

  it("wires portable-coordinator Action inputs through a trusted shell-safe array", () => {
    const action = readFileSync(resolve(root, "action.yml"), "utf-8");

    for (const input of ["repository", "ready-label", "merge-method", "transaction-checks", "state-checks", "format"]) {
      assert.match(action, new RegExp(`\\n  ${input}:\\n`), `Action exposes ${input}`);
    }
    assert.match(action, /portable-coordinator/);

    for (const [envName, input] of [
      ["INPUT_MODE", "mode"],
      ["INPUT_REPOSITORY", "repository"],
      ["INPUT_READY_LABEL", "ready-label"],
      ["INPUT_MERGE_METHOD", "merge-method"],
      ["INPUT_TRANSACTION_CHECKS", "transaction-checks"],
      ["INPUT_STATE_CHECKS", "state-checks"],
      ["INPUT_FORMAT", "format"],
    ]) {
      assert.match(action, new RegExp(`${envName}: \\$\\{\\{ inputs\\.${input} \\}\\}`));
    }

    assert.match(action, /if \[ "\$INPUT_MODE" = "portable-coordinator" \]; then/);
    assert.match(action, /CMD=\(node "\$\{GITHUB_ACTION_PATH\}\/dist\/repo-guard\.mjs" portable-coordinator\)/);
    assert.match(action, /CMD\+=\(--repository "\$INPUT_REPOSITORY"\)/);
    assert.match(action, /CMD\+=\(--ready-label "\$INPUT_READY_LABEL"\)/);
    assert.match(action, /CMD\+=\(--merge-method "\$INPUT_MERGE_METHOD"\)/);
    assert.match(action, /CMD\+=\(--format "\$INPUT_FORMAT"\)/);
    assert.match(action, /CMD\+=\(--transaction-check "\$CHECK"\)/);
    assert.match(action, /done <<< "\$INPUT_TRANSACTION_CHECKS"/);
    assert.match(action, /CMD\+=\(--state-check "\$CHECK"\)/);
    assert.match(action, /done <<< "\$INPUT_STATE_CHECKS"/);
    assert.match(action, /OUTPUT=\$\("\$\{CMD\[@\]\}" 2>&1\)/);

    assert.match(action, /CMD="\$CMD --repo-root \$REPO_ROOT"/, "legacy Action branch remains present");
  });
});
