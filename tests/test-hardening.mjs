import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileAnchorPolicy, compileChangeProfiles, compileForbidRegex, compileIntegrationPolicy, warnReservedPolicyFields } from "../src/policy-compiler.mjs";
import { checkMustTouch } from "../src/checks/rules/constraints.mjs";
import { checkIssueFallbackPrerequisites, checkPrerequisites } from "../src/github-pr.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoGuard = resolve(projectRoot, "src/repo-guard.mjs");
const runRepoGuard = (args, options = {}) => spawnSync(process.execPath, [repoGuard, ...args], { cwd: options.cwd || projectRoot, env: options.env || process.env, encoding: "utf-8" });

function initTinyRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init", { cwd: root, stdio: "pipe" }); execSync("git config user.email test@test.com", { cwd: root, stdio: "pipe" }); execSync("git config user.name Test", { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify({
    policy_format_version: "0.1.0", repository_kind: "library",
    paths: { forbidden: [], canonical_docs: ["README.md"], governance_paths: ["repo-policy.json"] },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 }, content_rules: [], cochange_rules: [],
  }));
  writeFileSync(join(root, "a.txt"), "a\nb\n"); execSync("git add -A && git commit -m init", { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "a.txt"), "a\n"); execSync("git add -A && git commit -m second", { cwd: root, stdio: "pipe" });
  return root;
}

describe("semantic compiler hardening", () => {
  it("eagerly compiles regexes", () => {
    const errors = compileForbidRegex([{ id: "bad", forbid_regex: ["[invalid(", "ok"] }]);
    assert.equal(errors.length, 1); assert.equal(errors[0].rule_id, "bad");
  });
  it("rejects contradictory and unknown change-profile references", () => {
    const errors = compileChangeProfiles({
      surfaces: { source: ["src/**"] }, new_file_classes: { test: ["tests/**"] },
      change_profiles: { feature: { allow_surfaces: ["source", "missing"], forbid_surfaces: ["source"], new_files: { allow_classes: ["test", "generated"] } } },
    });
    assert.ok(errors.some((e) => e.message.includes("missing"))); assert.ok(errors.some((e) => e.message.includes("both allow_surfaces"))); assert.ok(errors.some((e) => e.message.includes("generated")));
  });
  it("validates anchor cross-references, duplicate ids and regexes", () => {
    const anchors = { types: { requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**", field: "id" }] } } };
    assert.equal(compileAnchorPolicy({ anchors, trace_rules: [{ id: "resolve", kind: "must_resolve", from_anchor_type: "missing", to_anchor_type: "requirement_id" }] }).length, 1);
    assert.ok(compileAnchorPolicy({ anchors, trace_rules: [
      { id: "same", kind: "must_resolve", from_anchor_type: "requirement_id", to_anchor_type: "requirement_id" },
      { id: "same", kind: "must_resolve", from_anchor_type: "requirement_id", to_anchor_type: "requirement_id" },
    ] }).some((e) => e.message.includes("duplicates")));
    assert.equal(compileAnchorPolicy({ anchors: { types: { ref: { sources: [{ kind: "regex", glob: "src/**", pattern: "[bad" }] } } } }).length, 1);
  });
  it("keeps integration compiler focused on ids and cross-references", () => {
    assert.deepEqual(compileIntegrationPolicy({ integration: {
      workflows: [{ id: "gate", kind: "github_actions", path: "ci.yml", role: "repo_guard_pr_gate", profiles: ["strict"] }],
      profiles: [{ id: "strict", doc_path: "README.md" }],
    } }), []);
    const invalid = compileIntegrationPolicy({ integration: { workflows: [{ id: "dup" }, { id: "dup", profiles: ["missing"] }] } });
    assert.ok(invalid.some((e) => e.message.includes("duplicates"))); assert.ok(invalid.some((e) => e.message.includes("missing")));
  });
  it("keeps only the remaining policy reservation visible", () => assert.equal(warnReservedPolicyFields({ paths: { public_api: ["src/api/**"] } }).length, 1));
});

describe("runtime hardening", () => {
  it("preserves must_touch any-of semantics", () => {
    const files = [{ path: "src/app.mjs" }, { path: "tests/app.test.mjs" }];
    assert.equal(checkMustTouch(files, ["docs/**", "tests/**"]).ok, true);
    const failed = checkMustTouch(files, ["docs/**"]); assert.equal(failed.ok, false); assert.match(failed.hint, /any-of/);
  });
  it("separates mandatory git prerequisites from optional linked-issue gh lookup", () => {
    const originalEvent = process.env.GITHUB_EVENT_PATH; delete process.env.GITHUB_EVENT_PATH;
    try { assert.ok(checkPrerequisites().some((item) => item.includes("GITHUB_EVENT_PATH"))); }
    finally { if (originalEvent !== undefined) process.env.GITHUB_EVENT_PATH = originalEvent; }
    const root = mkdtempSync(join(tmpdir(), "rg-no-gh-")), fakeGit = join(root, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nprintf 'git version 2.0.0\\n'\n"); chmodSync(fakeGit, 0o755);
    const originalPath = process.env.PATH; process.env.PATH = root; process.env.GITHUB_EVENT_PATH = join(root, "event.json");
    try { assert.equal(checkPrerequisites().some((item) => item.includes("gh CLI")), false); assert.equal(checkIssueFallbackPrerequisites().some((item) => item.includes("gh CLI")), true); }
    finally { process.env.PATH = originalPath; if (originalEvent !== undefined) process.env.GITHUB_EVENT_PATH = originalEvent; else delete process.env.GITHUB_EVENT_PATH; rmSync(root, { recursive: true, force: true }); }
  });
  it("passes shell-looking refs to git without shell execution", () => {
    const root = initTinyRepo("rg-ref-injection-");
    try {
      const marker = join(root, "injected");
      const result = runRepoGuard(["check-diff", "--repo-root", root, "--base", `HEAD~1; touch ${marker}; #`, "--head", "HEAD"]);
      assert.equal(result.status, 1); assert.match(`${result.stdout}${result.stderr}`, /git diff failed/); assert.equal(existsSync(marker), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
