import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRoots } from "../src/repo-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

// --- resolveRoots: default uses process.cwd() ---

{
  const roots = resolveRoots([]);
  expect("default repoRoot is cwd", roots.repoRoot, process.cwd());
  expect("packageRoot is project root", roots.packageRoot, projectRoot);
  expect("args empty when no args given", roots.args.length, 0);
}

// --- resolveRoots: --repo-root override ---

{
  const roots = resolveRoots(["--repo-root", "/tmp/other-repo"]);
  expect("--repo-root overrides repoRoot", roots.repoRoot, resolve("/tmp/other-repo"));
  expect("--repo-root stripped from args", roots.args.length, 0);
  expect("packageRoot unchanged with --repo-root", roots.packageRoot, projectRoot);
}

// --- resolveRoots: --repo-root mixed with other args ---

{
  const roots = resolveRoots(["--base", "main", "--repo-root", "/tmp/other", "--head", "dev"]);
  expect("mixed args: repoRoot", roots.repoRoot, resolve("/tmp/other"));
  expect("mixed args: filtered length", roots.args.length, 4);
  expect("mixed args: --base preserved", roots.args[0], "--base");
  expect("mixed args: main preserved", roots.args[1], "main");
  expect("mixed args: --head preserved", roots.args[2], "--head");
  expect("mixed args: dev preserved", roots.args[3], "dev");
}

// --- resolveRoots: packageRoot and repoRoot are independent ---

{
  const roots = resolveRoots(["--repo-root", "/tmp/target"]);
  expect("packageRoot != repoRoot when --repo-root set",
    roots.packageRoot !== roots.repoRoot, true);
}

// --- self-hosted mode: validate works when cwd is repo-guard ---

{
  try {
    const output = execSync(`node src/repo-guard.mjs`, {
      encoding: "utf-8",
      cwd: projectRoot,
    });
    expect("self-hosted validate passes", output.includes("OK: repo-policy.json"), true);
  } catch (e) {
    expect("self-hosted validate passes", false, true);
  }
}

// --- explicit --repo-root: validate loads policy from target repo ---

{
  const tmp = mkdtempSync(join(tmpdir(), "rg-repo-root-"));
  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy));

  try {
    const output = execSync(
      `node src/repo-guard.mjs --repo-root ${tmp}`,
      { encoding: "utf-8", cwd: projectRoot }
    );
    expect("--repo-root validate loads external policy", output.includes("OK: repo-policy.json"), true);
  } catch (e) {
    expect("--repo-root validate loads external policy", false, true);
  }

  rmSync(tmp, { recursive: true });
}

// --- schemas still load from package assets, not from --repo-root ---

{
  const tmp = mkdtempSync(join(tmpdir(), "rg-repo-root-"));
  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy));

  try {
    const output = execSync(
      `node src/repo-guard.mjs --repo-root ${tmp}`,
      { encoding: "utf-8", cwd: projectRoot }
    );
    expect("schemas load from package (no schemas/ in target)", output.includes("OK: repo-policy.json"), true);
  } catch (e) {
    expect("schemas load from package (no schemas/ in target)", false, true);
  }

  rmSync(tmp, { recursive: true });
}

// --- check-diff with --repo-root uses target repo git ---

{
  const tmp = mkdtempSync(join(tmpdir(), "rg-repo-root-"));
  execSync("git init", { cwd: tmp });
  execSync("git config user.email test@test.com && git config user.name Test", { cwd: tmp });

  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy));
  writeFileSync(join(tmp, "hello.txt"), "hello");
  execSync("git add -A && git commit -m init", { cwd: tmp });

  writeFileSync(join(tmp, "world.txt"), "world");
  execSync("git add -A && git commit -m second", { cwd: tmp });

  try {
    const output = execSync(
      `node src/repo-guard.mjs check-diff --repo-root ${tmp} --base HEAD~1 --head HEAD`,
      { encoding: "utf-8", cwd: projectRoot }
    );
    expect("check-diff --repo-root uses target git", output.includes("1 file(s) changed"), true);
    expect("check-diff --repo-root passes", output.includes("0 failed"), true);
  } catch (e) {
    expect("check-diff --repo-root uses target git", false, true);
  }

  rmSync(tmp, { recursive: true });
}

// --- validate resolves contract path relative to repoRoot ---

{
  const tmp = mkdtempSync(join(tmpdir(), "rg-contract-validate-"));
  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy));

  mkdirSync(join(tmp, "contracts"));
  const contract = {
    change_type: "feature",
    scope: ["src/**"],
    budgets: { max_new_files: 5 },
    must_touch: [],
    must_not_touch: [],
    expected_effects: ["test"],
  };
  writeFileSync(join(tmp, "contracts", "change.json"), JSON.stringify(contract));

  try {
    const output = execSync(
      `node src/repo-guard.mjs --repo-root ${tmp} contracts/change.json`,
      { encoding: "utf-8", cwd: projectRoot }
    );
    expect("validate resolves contract relative to repoRoot", output.includes("OK: repo-policy.json"), true);
    expect("validate contract passes schema check", output.includes("OK: contracts/change.json"), true);
  } catch (e) {
    const stderr = e.stderr || e.message || "";
    expect("validate resolves contract relative to repoRoot (no ENOENT)", !stderr.includes("ENOENT"), true);
    expect("validate resolves contract relative to repoRoot", false, true);
  }

  rmSync(tmp, { recursive: true });
}

// --- check-diff resolves --contract path relative to repoRoot ---

{
  const tmp = mkdtempSync(join(tmpdir(), "rg-contract-diff-"));
  execSync("git init", { cwd: tmp });
  execSync("git config user.email test@test.com && git config user.name Test", { cwd: tmp });

  const policy = {
    policy_format_version: "0.1.0",
    repository_kind: "library",
    paths: {
      forbidden: [],
      canonical_docs: ["README.md"],
      governance_paths: ["repo-policy.json"],
    },
    diff_rules: { max_new_docs: 5, max_new_files: 20, max_net_added_lines: 500 },
    content_rules: [],
    cochange_rules: [],
  };
  writeFileSync(join(tmp, "repo-policy.json"), JSON.stringify(policy));

  mkdirSync(join(tmp, "contracts"));
  const contract = {
    change_type: "feature",
    scope: ["**"],
    budgets: { max_new_files: 5, max_net_added_lines: 500 },
    must_touch: ["hello.txt"],
    must_not_touch: [],
    expected_effects: ["test"],
  };
  writeFileSync(join(tmp, "contracts", "change.json"), JSON.stringify(contract));

  writeFileSync(join(tmp, "hello.txt"), "hello");
  execSync("git add -A && git commit -m init", { cwd: tmp });

  writeFileSync(join(tmp, "hello.txt"), "hello world");
  execSync("git add -A && git commit -m second", { cwd: tmp });

  try {
    const output = execSync(
      `node src/repo-guard.mjs check-diff --repo-root ${tmp} --base HEAD~1 --head HEAD --contract contracts/change.json`,
      { encoding: "utf-8", cwd: projectRoot }
    );
    expect("check-diff resolves --contract relative to repoRoot", output.includes("1 file(s) changed"), true);
    expect("check-diff --contract passes with repoRoot", output.includes("0 failed"), true);
  } catch (e) {
    const stderr = e.stderr || e.message || "";
    expect("check-diff resolves --contract relative to repoRoot (no ENOENT)", !stderr.includes("ENOENT"), true);
    expect("check-diff resolves --contract relative to repoRoot", false, true);
  }

  rmSync(tmp, { recursive: true });
}

// --- check-pr respects repo root via roots parameter ---

{
  const roots = resolveRoots(["--repo-root", "/tmp/some-repo"]);
  expect("check-pr receives repoRoot through roots", roots.repoRoot, resolve("/tmp/some-repo"));
  expect("check-pr receives packageRoot through roots", roots.packageRoot, projectRoot);
}

console.log(`\n${failures === 0 ? "All tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
