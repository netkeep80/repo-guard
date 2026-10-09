import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolvePolicyPacks } from "../dist/policy-packs.mjs";
import {
  buildRequirementAuthorityFromSnapshot,
  compareRequirementRelationGraphs,
} from "../dist/requirement-relations.mjs";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

function policy(changedEvidence = ["src/**"]) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    enforcement: { mode: "blocking" },
    paths: {
      forbidden: [],
      canonical_docs: [],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 1000 },
    content_rules: [],
    cochange_rules: [],
    packs: {
      "requirements-strict": {
        requirement_yaml_globs: ["requirements/*.yaml"],
        requirement_id_pattern: "RG-[A-Z0-9-]+",
        strict_heading_docs: ["docs/**/*.md"],
        evidence_surfaces: changedEvidence,
        changed_requirement_evidence_surfaces: changedEvidence,
        closed_repository: true,
      },
    },
  };
}

function intent(scope) {
  return `\`\`\`repo-guard-yaml
change_type: feature
scope:
${scope.map((path) => `  - ${path}`).join("\n")}
budgets: {}
anchors: { affects: [], implements: [], verifies: [] }
must_touch: []
must_not_touch: []
expected_effects:
  - exercise exact requirement authority transition
\`\`\`

Fixes #77`;
}

function fakeGh(issueBody) {
  const root = mkdtempSync(join(tmpdir(), "rg-644-gh-"));
  const gh = join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const a=process.argv.slice(2), i=a.indexOf('--jq'), q=i>=0?a[i+1]:'';
if(a.includes('--version')) console.log('gh 0.0');
else if(q==='.body') console.log(${JSON.stringify(issueBody)});
else if(q.includes('author_association')) console.log(JSON.stringify({body:${JSON.stringify(issueBody)},user:{login:'maintainer',type:'User'},author_association:'OWNER',labels:[]}));
else if(q.includes('permission')) console.log(JSON.stringify({permission:'write',role_name:'write'}));
else console.log(JSON.stringify({labels:[]}));
`);
  chmodSync(gh, 0o755);
  return root;
}

function run(root, issueBody, scope) {
  const eventPath = join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 42,
      base: { sha: "HEAD~1" },
      head: { sha: "HEAD" },
      body: intent(scope),
    },
    repository: { full_name: "owner/repo" },
  }));
  const fakeDir = fakeGh(issueBody);
  try {
    return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr"], {
      cwd: root,
      env: { ...process.env, RG_EVENT_PATH: eventPath, PATH: `${fakeDir}:${process.env.PATH}` },
      encoding: "utf-8",
    });
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

function authorityGrant(rawPolicy, baseSha, headSha, baseFiles, headFiles, baseRequirements, headRequirements) {
  const resolved = resolvePolicyPacks(rawPolicy);
  assert.equal(resolved.ok, true);
  const read = (files) => (_revision, path) => files[path] ?? null;
  const base = buildRequirementAuthorityFromSnapshot({
    policy: resolved.policy,
    snapshot: "base",
    revision: baseSha,
    trackedFiles: baseFiles,
    readFileAtRef: read(baseRequirements),
  });
  const head = buildRequirementAuthorityFromSnapshot({
    policy: resolved.policy,
    snapshot: "head",
    revision: headSha,
    trackedFiles: headFiles,
    readFileAtRef: read(headRequirements),
  });
  assert.ok(base && head);
  const delta = compareRequirementRelationGraphs(base, head);
  return {
    base_authority_sha256: base.authority_sha256,
    expected_head_authority_sha256: head.authority_sha256,
    add: delta.add,
    remove: delta.remove,
  };
}

function issueGrant(transition) {
  return `\`\`\`repo-guard-grant
requirement_transition:
  base_authority_sha256: ${transition.base_authority_sha256}
  expected_head_authority_sha256: ${transition.expected_head_authority_sha256}
  add: ${JSON.stringify(transition.add)}
  remove: ${JSON.stringify(transition.remove)}
\`\`\``;
}

function initRepo(rawPolicy, requirements, extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "rg-644-runtime-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@test.com");
  git(root, "config", "user.name", "Test");
  mkdirSync(join(root, "requirements"), { recursive: true });
  writeFileSync(join(root, "repo-policy.json"), JSON.stringify(rawPolicy, null, 2));
  for (const [path, content] of Object.entries(requirements)) writeFileSync(join(root, path), content);
  for (const [path, content] of Object.entries(extraFiles)) {
    const parent = resolve(root, path, "..");
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  return root;
}

console.log("\n--- #644 check-pr self-authorization boundary ---");
{
  const rawPolicy = policy(["garbage.tmp"]);
  const baseReq = [
    "id: RG-ROOT",
    "artifacts:",
    "  - path: requirements/root.yaml",
    "    role: requirement",
    "  - path: repo-policy.json",
    "    role: governance",
    "",
  ].join("\n");
  const headReq = [
    "id: RG-ROOT",
    "artifacts:",
    "  - path: requirements/root.yaml",
    "    role: requirement",
    "  - path: repo-policy.json",
    "    role: governance",
    "  - path: garbage.tmp",
    "    role: implementation",
    "",
  ].join("\n");
  const root = initRepo(rawPolicy, { "requirements/root.yaml": baseReq });
  try {
    const baseSha = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "requirements/root.yaml"), headReq);
    writeFileSync(join(root, "garbage.tmp"), "candidate-owned garbage\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "candidate self authorization");
    const headSha = git(root, "rev-parse", "HEAD");
    const baseFiles = git(root, "ls-tree", "-r", "--name-only", baseSha).split("\n").filter(Boolean);
    const headFiles = git(root, "ls-tree", "-r", "--name-only", headSha).split("\n").filter(Boolean);
    const transition = authorityGrant(
      rawPolicy, baseSha, headSha, baseFiles, headFiles,
      { "requirements/root.yaml": baseReq },
      { "requirements/root.yaml": headReq },
    );

    const ungranted = run(root, "", ["requirements/**", "garbage.tmp"]);
    const ungrantedOutput = `${ungranted.stdout || ""}${ungranted.stderr || ""}`;
    assert.equal(ungranted.status, 1, ungrantedOutput);
    assert.match(ungrantedOutput, /FAIL: requirement-transition/);
    assert.match(ungrantedOutput, /requirement_transition_grant_missing/);

    const granted = run(root, issueGrant(transition), ["requirements/**", "garbage.tmp"]);
    const grantedOutput = `${granted.stdout || ""}${granted.stderr || ""}`;
    assert.equal(granted.status, 0, grantedOutput);
    assert.match(grantedOutput, /PASS: requirement-transition/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n--- #644 check-pr administrative transition evidence boundary ---");
{
  const rawPolicy = policy(["src/**"]);
  const baseR1 = [
    "id: RG-R1",
    "artifacts:",
    "  - path: requirements/r1.yaml",
    "    role: requirement",
    "  - path: repo-policy.json",
    "    role: governance",
    "  - path: src/a.mts",
    "    role: implementation",
    "",
  ].join("\n");
  const baseR2 = [
    "id: RG-R2",
    "artifacts:",
    "  - path: requirements/r2.yaml",
    "    role: requirement",
    "",
  ].join("\n");
  const headR1 = [
    "id: RG-R1",
    "artifacts:",
    "  - path: requirements/r1.yaml",
    "    role: requirement",
    "  - path: repo-policy.json",
    "    role: governance",
    "",
  ].join("\n");
  const headR2 = [
    "id: RG-R2",
    "artifacts:",
    "  - path: requirements/r2.yaml",
    "    role: requirement",
    "  - path: src/a.mts",
    "    role: implementation",
    "",
  ].join("\n");
  const root = initRepo(rawPolicy, {
    "requirements/r1.yaml": baseR1,
    "requirements/r2.yaml": baseR2,
  }, { "src/a.mts": "export const a = true;\n" });
  try {
    const baseSha = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "requirements/r1.yaml"), headR1);
    writeFileSync(join(root, "requirements/r2.yaml"), headR2);
    git(root, "add", "requirements/r1.yaml", "requirements/r2.yaml");
    git(root, "commit", "-m", "transfer ownership only");
    const headSha = git(root, "rev-parse", "HEAD");
    const baseFiles = git(root, "ls-tree", "-r", "--name-only", baseSha).split("\n").filter(Boolean);
    const headFiles = git(root, "ls-tree", "-r", "--name-only", headSha).split("\n").filter(Boolean);
    const transition = authorityGrant(
      rawPolicy, baseSha, headSha, baseFiles, headFiles,
      { "requirements/r1.yaml": baseR1, "requirements/r2.yaml": baseR2 },
      { "requirements/r1.yaml": headR1, "requirements/r2.yaml": headR2 },
    );
    const granted = run(root, issueGrant(transition), ["requirements/**"]);
    const output = `${granted.stdout || ""}${granted.stderr || ""}`;
    assert.equal(granted.status, 0, output);
    assert.match(output, /PASS: requirement-transition/);
    assert.doesNotMatch(output, /FAIL: trace-rule: changed-requirements-need-evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n--- #670 check-pr advisory overlap shadow ---");
{
  const rawPolicy = policy(["src/**", "tests/**"]);
  const requirement = (id, artifacts) => [
    `id: ${id}`,
    "artifacts:",
    ...artifacts.flatMap(({ path, relations }) => [
      `  - path: ${path}`,
      `    relations: [${relations.join(", ")}]`,
    ]),
    "",
  ].join("\n");
  const r1 = requirement("RG-A", [
    { path: "requirements/r1.yaml", relations: ["requires"] },
    { path: "repo-policy.json", relations: ["requires"] },
    { path: "src/a.mts", relations: ["requires", "implements"] },
  ]);
  const r2 = requirement("RG-B", [
    { path: "requirements/r2.yaml", relations: ["requires"] },
    { path: "tests/b.mjs", relations: ["requires", "verifies"] },
  ]);
  const root = initRepo(rawPolicy, { "requirements/r1.yaml": r1, "requirements/r2.yaml": r2 }, {
    "src/a.mts": "export const a = 1;\n",
    "tests/b.mjs": "export const b = 1;\n",
  });
  try {
    writeFileSync(join(root, "src/a.mts"), "export const a = 2;\n");
    writeFileSync(join(root, "tests/b.mjs"), "export const b = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "implementation with unrelated verification");
    const result = run(root, "", ["src/**", "tests/**"]);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /WARN: requirement-verification-overlap-shadow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
{
  const rawPolicy = policy(["src/**", "tests/**"]);
  const r1 = [
    "id: RG-A",
    "artifacts:",
    "  - path: requirements/r1.yaml",
    "    relations: [requires]",
    "  - path: repo-policy.json",
    "    relations: [requires]",
    "  - path: src/a.mts",
    "    relations: [requires, implements]",
    "  - path: tests/a.mjs",
    "    relations: [requires, verifies]",
    "",
  ].join("\n");
  const root = initRepo(rawPolicy, { "requirements/r1.yaml": r1 }, {
    "src/a.mts": "export const a = 1;\n",
    "tests/a.mjs": "export const t = 1;\n",
  });
  try {
    writeFileSync(join(root, "src/a.mts"), "export const a = 2;\n");
    writeFileSync(join(root, "tests/a.mjs"), "export const t = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "implementation with related verification");
    const result = run(root, "", ["src/**", "tests/**"]);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /PASS: requirement-verification-overlap-shadow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


console.log("\n--- #670 no requirement authority means no overlap shadow ---");
{
  const rawPolicy = policy(["src/**", "tests/**"]);
  delete rawPolicy.packs;
  const root = initRepo(rawPolicy, {}, {
    "src/a.mts": "export const a = 1;\n",
    "tests/a.mjs": "export const t = 1;\n",
  });
  try {
    writeFileSync(join(root, "src/a.mts"), "export const a = 2;\n");
    writeFileSync(join(root, "tests/a.mjs"), "export const t = 2;\n");
    git(root, "add", "-A");
    git(root, "commit", "-m", "plain repository without requirement authority");
    const result = run(root, "", ["src/**", "tests/**"]);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /requirement-verification-overlap-shadow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("#644 check-pr requirement transition runtime witnesses passed");
