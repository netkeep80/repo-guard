import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = new URL(".", import.meta.url).pathname;
const projectRoot = resolve(__dirname, "..");
const repoGuard = resolve(projectRoot, "dist/repo-guard.mjs");
let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, value, substring) {
  expect(label, value.includes(substring), true);
}

function runGuard(args) {
  const result = spawnSync(process.execPath, [repoGuard, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function makeRepo({ policy, baseFiles = {}, headFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-output-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeTree(dir, {
    "repo-policy.json": JSON.stringify(policy, null, 2),
    "README.md": "# Test\n",
    ...baseFiles,
  });
  execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
  writeTree(dir, headFiles);
  execSync("git add -A && git commit -m change", { cwd: dir, stdio: "pipe" });
  return {
    dir,
    base: execSync("git rev-parse HEAD~1", { cwd: dir, encoding: "utf-8" }).trim(),
    head: execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim(),
  };
}

function basePolicy(extra = {}) {
  return {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: {
      max_new_docs: 5,
      max_new_files: 10,
      max_net_added_lines: 500,
    },
    content_rules: [],
    cochange_rules: [],
    ...extra,
  };
}

function runJson(repo, extraArgs = []) {
  const result = runGuard([
    "--repo-root", repo.dir,
    "check-diff",
    "--format", "json",
    "--base", repo.base,
    "--head", repo.head,
    ...extraArgs,
  ]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    expect("stdout is valid JSON", error.message, "valid JSON");
  }
  return { result, parsed };
}

console.log("\n--- stable JSON envelope and violation details ---");
{
  const policy = basePolicy({
    paths: {
      forbidden: ["secrets/**"],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    cochange_rules: [{ if_changed: ["src/**"], must_change_any: ["tests/**"] }],
  });
  const repo = makeRepo({
    policy,
    headFiles: {
      "src/feature.mjs": "export const value = 1;\n",
      "secrets/token.txt": "token\n",
    },
  });
  const { result, parsed } = runJson(repo);
  expect("blocking violations set exit code", result.code, 1);
  expect("JSON mode keeps stderr empty", result.stderr, "");
  expect("command is stable", parsed?.command, "check-diff");
  expect("mode is stable", parsed?.mode, "blocking");
  expect("repository root is reported", parsed?.repositoryRoot, repo.dir);
  expect("result records failure", parsed?.ok, false);
  expect("forbidden violation is structured",
    parsed?.violations.some((item) => item.rule === "forbidden-paths" && item.data?.files?.includes("secrets/token.txt")), true);
  expect("cochange violation is structured",
    parsed?.violations.some((item) => item.rule.startsWith("cochange:") && item.data?.must_touch?.includes("tests/**")), true);
  const keys = Object.keys(parsed || {}).sort();
  expect("top-level JSON envelope remains stable", JSON.stringify(keys), JSON.stringify([
    "advisoryWarnings", "command", "diff", "exitCode", "failed", "hints", "mode", "ok",
    "passed", "repositoryRoot", "result", "ruleResults", "violationCount", "violations", "warnings",
  ].sort()));
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- ChangeIntent anchors are exposed in JSON and summary output ---");
{
  const policy = basePolicy({
    anchors: {
      types: {
        requirement_id: { sources: [{ kind: "json_field", glob: "requirements/**/*.json", field: "id" }] },
        code_req_ref: { sources: [{ kind: "regex", glob: "src/**", pattern: "@req\\s+([A-Z]+-[0-9]+)" }] },
        doc_req_ref: { sources: [{ kind: "regex", glob: "docs/**/*.md", pattern: "\\[([A-Z]+-[0-9]+)\\]" }] },
      },
    },
    trace_rules: [
      { id: "code-refs-must-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-refs-must-resolve", kind: "must_resolve", from_anchor_type: "doc_req_ref", to_anchor_type: "requirement_id" },
    ],
  });
  const changeIntent = {
    change_type: "feature",
    scope: ["src/**", "docs/**"],
    budgets: {},
    anchors: { affects: ["FR-001"], implements: ["FR-999"], verifies: ["FR-404"] },
    must_touch: [],
    must_not_touch: [],
    expected_effects: ["Expose anchor diagnostics"],
  };
  const repo = makeRepo({
    policy,
    baseFiles: {
      "change-intent.json": JSON.stringify(changeIntent, null, 2),
      "requirements/fr-001.json": JSON.stringify({ id: "FR-001" }),
      "requirements/fr-002.json": JSON.stringify({ id: "FR-002" }),
    },
    headFiles: {
      "src/feature.mjs": "export const x = true; // @req FR-001\n// @req FR-999\n",
      "docs/feature.md": "Covers [FR-002] and [FR-404].\n",
    },
  });
  const { result, parsed } = runJson(repo, ["--change-intent", "change-intent.json"]);
  expect("unresolved anchors block", result.code, 1);
  expect("detected anchor count is exposed", parsed?.anchors?.stats?.detected, 6);
  expect("changed anchor count is exposed", parsed?.anchors?.stats?.changed, 4);
  expect("declared ChangeIntent anchors are exposed", parsed?.anchors?.stats?.declaredByChangeIntent, 3);
  expect("unresolved anchor count is exposed", parsed?.anchors?.stats?.unresolved, 2);
  expect("declared affects value is exposed", parsed?.anchors?.declaredByChangeIntent?.affects?.[0], "FR-001");
  expect("trace diagnostics remain structured", parsed?.traceRuleResults?.length, 2);

  const summary = runGuard([
    "--repo-root", repo.dir,
    "check-diff",
    "--format", "summary",
    "--base", repo.base,
    "--head", repo.head,
    "--change-intent", "change-intent.json",
  ]);
  expectIncludes("summary exposes anchor totals", summary.output, "6 detected, 4 changed, 3 declared, 2 unresolved");
  expectIncludes("summary exposes unresolved value", summary.output, "FR-999");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- malformed ChangeIntent uses canonical validation diagnostic ---");
{
  const changeIntent = {
    change_type: "feature",
    scope: ["src/**"],
    budgets: {},
    anchors: { affects: ["FR-014", "FR-014"] },
    must_touch: [],
    must_not_touch: [],
    expected_effects: ["Reject duplicate anchor intent"],
  };
  const repo = makeRepo({
    policy: basePolicy(),
    baseFiles: { "change-intent.json": JSON.stringify(changeIntent, null, 2) },
    headFiles: { "src/feature.mjs": "export const value = 1;\n" },
  });
  const { result, parsed } = runJson(repo, ["--change-intent", "change-intent.json"]);
  expect("malformed ChangeIntent blocks", result.code, 1);
  const violation = parsed?.violations.find((item) => item.rule === "change-intent");
  expect("canonical ChangeIntent violation is present", Boolean(violation), true);
  expect("schema path remains visible", violation?.details.some((detail) => detail.includes("/anchors/affects")), true);
  expect("duplicate diagnostic remains visible", violation?.details.some((detail) => detail.includes("duplicate")), true);
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- registry diagnostics keep relation evidence structured ---");
{
  const policy = basePolicy({
    paths: {
      forbidden: [],
      canonical_docs: ["README.md", "docs/policy.md"],
      governance_paths: ["repo-policy.json"],
    },
    registry_rules: [{
      id: "canonical-docs-sync",
      kind: "set_equality",
      left: { type: "json_array", file: "repo-policy.json", json_pointer: "/paths/canonical_docs" },
      right: { type: "markdown_section_links", file: "docs/index.md", section: "Canonical Documents", prefix: "docs/" },
    }],
  });
  const repo = makeRepo({
    policy,
    baseFiles: {
      "docs/policy.md": "# Policy\n",
      "docs/index.md": "# Docs\n\n## Canonical Documents\n\n- [Readme](../README.md)\n- [Architecture](architecture.md)\n",
    },
    headFiles: { "README.md": "# Test\n\nChanged.\n" },
  });
  const { result, parsed } = runJson(repo);
  expect("registry mismatch blocks", result.code, 1);
  const violation = parsed?.violations.find((item) => item.rule === "registry-rules");
  expect("registry violation is present", Boolean(violation), true);
  expect("missing relation entry is exposed", violation?.data?.results?.[0]?.missing_from_right?.[0], "docs/policy.md");
  expect("extra relation entry is exposed", violation?.data?.results?.[0]?.extra_in_right?.[0], "docs/architecture.md");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- size violations retain machine-readable measurements ---");
{
  const repo = makeRepo({
    policy: basePolicy({
      size_rules: [{ id: "max-src-lines", scope: "file", metric: "lines", glob: "src/**/*.mjs", max: 2 }],
    }),
    headFiles: { "src/big.mjs": "one\ntwo\nthree\n" },
  });
  const { result, parsed } = runJson(repo);
  expect("size violation blocks", result.code, 1);
  const measurement = parsed?.violations.find((item) => item.rule === "size-rules")?.data?.size_violations?.[0];
  expect("size rule id is exposed", measurement?.ruleId, "max-src-lines");
  expect("measured line count is exposed", measurement?.actual, 3);
  expect("configured maximum is exposed", measurement?.max, 2);
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- surface debt status is exposed without duplicating debt semantics ---");
{
  const changeIntent = {
    change_type: "feature",
    scope: ["src/**"],
    budgets: {},
    surface_debt: {
      kind: "temporary_growth",
      reason: "Temporary extraction seam",
      expected_delta: { max_new_files: 1, max_net_added_lines: 20 },
      repayment_issue: 123,
    },
    must_touch: [],
    must_not_touch: [],
    expected_effects: ["Make temporary growth explicit"],
  };
  const repo = makeRepo({
    policy: basePolicy(),
    baseFiles: { "change-intent.json": JSON.stringify(changeIntent, null, 2) },
    headFiles: { "src/growth.mjs": `${new Array(12).fill("export const value = 1;").join("\n")}\n` },
  });
  const { result, parsed } = runJson(repo, ["--change-intent", "change-intent.json"]);
  expect("declared debt stays within budget", result.code, 0);
  const debt = parsed?.ruleResults.find((item) => item.rule === "surface-debt");
  expect("surface debt rule passes", debt?.ok, true);
  expect("declared status is exposed", debt?.details.includes("status: declared"), true);
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- advisory warnings remain non-blocking and structured ---");
{
  const repo = makeRepo({
    policy: basePolicy({
      repository_kind: "documentation",
      paths: {
        forbidden: [],
        canonical_docs: ["docs/canonical.md"],
        governance_paths: ["repo-policy.json"],
      },
      advisory_text_rules: {
        canonical_files: ["docs/canonical.md"],
        warn_on_similarity_above: 0.7,
        max_reported_matches: 2,
      },
    }),
    baseFiles: {
      "docs/canonical.md": "# Release Policy\n\nPolicy prose belongs in the canonical document so maintainers update one source.\n",
    },
    headFiles: {
      "docs/copy.md": "# Release Policy\n\nPolicy prose belongs in the canonical document so maintainers update one source.\n",
    },
  });
  const { result, parsed } = runJson(repo);
  expect("advisory warning does not block", result.code, 0);
  expect("result records warnings", parsed?.result, "passed_with_warnings");
  expect("warning count is stable", parsed?.warnings, 1);
  const warning = parsed?.advisoryWarnings.find((item) => item.rule === "advisory-text-rules");
  expect("changed file is exposed", warning?.data?.matches?.[0]?.changed_file, "docs/copy.md");
  expect("canonical file is exposed", warning?.data?.matches?.[0]?.canonical_file, "docs/canonical.md");
  rmSync(repo.dir, { recursive: true });
}

console.log("\n--- summary output stays concise and GitHub-friendly ---");
{
  const policy = basePolicy({
    paths: {
      forbidden: ["secrets/**"],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
  });
  const repo = makeRepo({ policy, headFiles: { "secrets/token.txt": "token\n" } });
  const result = runGuard([
    "--repo-root", repo.dir,
    "--enforcement", "advisory",
    "check-diff",
    "--format", "summary",
    "--base", repo.base,
    "--head", repo.head,
  ]);
  expect("advisory summary exits zero", result.code, 0);
  expectIncludes("summary heading is stable", result.output, "## repo-guard summary");
  expectIncludes("summary records failed analysis", result.output, "- Result: failed");
  expectIncludes("summary records advisory mode", result.output, "- Mode: advisory");
  expectIncludes("summary includes violation table", result.output, "| Rule | Details |");
  expectIncludes("summary includes offending path", result.output, "secrets/token.txt");
  rmSync(repo.dir, { recursive: true });
}

console.log(`\n${failures === 0 ? "All structured output contract tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
