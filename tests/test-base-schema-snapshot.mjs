import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const currentSchemaPath = resolve(projectRoot, "schemas/repo-policy.schema.json");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
const snapshotOnlyKind = "snapshot_only_kind";

function intent() {
  return `\`\`\`repo-guard-yaml
change_type: governance
scope:
  - repo-policy.json
  - schemas/**
budgets: {}
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - repo-policy.json
  - schemas/repo-policy.schema.json
must_not_touch: []
expected_effects:
  - trusted base policy is interpreted by its trusted base schema
\`\`\``;
}

function policy({ withSnapshotOnlyKind }) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: withSnapshotOnlyKind ? snapshotOnlyKind : "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json", "schemas/**"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
    content_rules: [],
    cochange_rules: [],
  };
}

function baseSchema() {
  const schema = JSON.parse(readFileSync(currentSchemaPath, "utf-8"));
  schema.properties.repository_kind.enum.push(snapshotOnlyKind);
  return schema;
}

function runCheck(root) {
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 42,
      base: { sha: "HEAD~1" },
      head: { sha: "HEAD" },
      body: intent(),
    },
    repository: { full_name: "owner/repo" },
  }));
  return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: "utf-8",
  });
}

const root = mkdtempSync(join(tmpdir(), "rg-base-schema-snapshot-"));
try {
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@test.com");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, "schemas"), { recursive: true });

  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy({ withSnapshotOnlyKind: true }), null, 2));
  writeFileSync(join(root, "schemas/repo-policy.schema.json"), JSON.stringify(baseSchema(), null, 2));
  git(root, "add", "-A");
  git(root, "commit", "-m", "trusted base with snapshot-only schema value");

  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(policy({ withSnapshotOnlyKind: false }), null, 2));
  writeFileSync(join(root, "schemas/repo-policy.schema.json"), readFileSync(currentSchemaPath, "utf-8"));
  git(root, "add", "-A");
  git(root, "commit", "-m", "remove snapshot-only schema value");

  const result = runCheck(root);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.doesNotMatch(output, /Base policy compilation failed/, output);
  assert.match(output, /Proposed policy differs from trusted base/, output);
  console.log("Trusted BASE schema snapshot regression passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
