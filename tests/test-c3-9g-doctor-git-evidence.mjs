import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runDoctor } from "../dist/doctor.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const tmp = mkdtempSync(join(tmpdir(), "repo-guard-c39g-"));
try {
  const source = join(tmp, "source");
  const shallow = join(tmp, "shallow");
  mkdirSync(source);
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "repo-guard@example.invalid"]);
  git(source, ["config", "user.name", "repo-guard test"]);
  copyFileSync(resolve(root, "repo-policy.json"), join(source, "repo-policy.json"));
  writeFileSync(join(source, "README.md"), "# Fixture\n", "utf8");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "base"]);
  writeFileSync(join(source, "README.md"), "# Fixture\n\nsecond commit\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "head"]);
  execFileSync("git", ["clone", "--depth", "1", pathToFileURL(source).href, shallow], { encoding: "utf8", stdio: "pipe" });
  assert.equal(git(shallow, ["rev-parse", "--is-shallow-repository"]), "true");

  const previousEventPath = process.env.GITHUB_EVENT_PATH;
  const originalLog = console.log;
  delete process.env.GITHUB_EVENT_PATH;
  console.log = () => {};
  try {
    const report = runDoctor({ packageRoot: root, repoRoot: shallow });
    const evidence = report.results.find((item) => item.name === "git-evidence");
    assert.ok(evidence, "doctor must expose git-evidence instead of fetch-depth");
    assert.equal(evidence.status, "PASS", "shallow state alone must not be a warning");
    assert.equal(report.results.some((item) => item.name === "fetch-depth"), false);
    const diagnostics = report.results.flatMap((item) => [item.message, item.hint || ""]).join("\n");
    assert.doesNotMatch(diagnostics, /fetch-depth:\s*0|Full history available/);
  } finally {
    console.log = originalLog;
    if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEventPath;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("C3.9g doctor Git-evidence diagnostics ratchet passed.");
