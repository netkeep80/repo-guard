import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiffObservation, runGit } from "../dist/git.mjs";

const scratch = mkdtempSync(join(tmpdir(), "repo-guard-large-diff-"));
const git = (...args) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim();

try {
  git("init", "--quiet");
  git("config", "user.email", "repo-guard@example.invalid");
  git("config", "user.name", "repo-guard");
  writeFileSync(join(scratch, "large.txt"), "seed\n");
  git("add", "large.txt");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");

  const large = Array.from(
    { length: 90000 },
    (_, index) => String(index).padStart(8, "0") + "-0123456789abcdef\n",
  ).join("");
  writeFileSync(join(scratch, "large.txt"), large);
  git("add", "large.txt");
  git("commit", "--quiet", "-m", "large diff");
  const head = git("rev-parse", "HEAD");

  const observation = getDiffObservation(base, head, scratch);
  assert.ok(Buffer.byteLength(observation.diffText, "utf8") > 1024 * 1024,
    "regression fixture must exceed Node execFileSync default maxBuffer");
  assert.equal(observation.files.length, 1);
  assert.equal(observation.files[0].path, "large.txt");
  assert.equal(observation.files[0].status, "modified");

  assert.throws(
    () => runGit(["show", "HEAD:large.txt"], { cwd: scratch, maxBuffer: 1024 }),
    /git show failed: output exceeded configured maxBuffer=1024 bytes/,
    "explicit bounded ceiling must remain fail-closed",
  );

  console.log("Large git diff buffer boundary passed.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
