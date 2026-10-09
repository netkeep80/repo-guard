import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRemoteBranchWithLease } from "../dist/git.mjs";

const root = mkdtempSync(join(tmpdir(), "repo-guard-647-lease-"));
const remote = join(root, "remote.git");
const work = join(root, "work");

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf-8",
  stdio: "pipe",
}).trim();
const remoteRef = (ref) => execFileSync("git", ["--git-dir", remote, "rev-parse", ref], {
  encoding: "utf-8",
  stdio: "pipe",
}).trim();

try {
  execFileSync("git", ["init", "--bare", remote], { encoding: "utf-8", stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", work], { encoding: "utf-8", stdio: "pipe" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Repo Guard Test");
  git(work, "remote", "add", "origin", remote);

  writeFileSync(join(work, "value.txt"), "base\n");
  git(work, "add", "value.txt");
  git(work, "commit", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "push", "-u", "origin", "main");

  git(work, "branch", "exact-delete", base);
  git(work, "push", "origin", "exact-delete");
  assert.equal(remoteRef("refs/heads/exact-delete"), base);

  const exactResult = deleteRemoteBranchWithLease({
    cwd: work,
    branch: "exact-delete",
    expectedSha: base,
  });
  assert.match(exactResult, /exact-delete/);
  assert.throws(
    () => remoteRef("refs/heads/exact-delete"),
    /unknown revision|Needed a single revision|ambiguous argument|fatal/i,
  );

  git(work, "branch", "moved-ref", base);
  git(work, "push", "origin", "moved-ref");
  git(work, "switch", "moved-ref");
  writeFileSync(join(work, "value.txt"), "base\nmoved\n");
  git(work, "add", "value.txt");
  git(work, "commit", "-m", "advance moved ref");
  const advanced = git(work, "rev-parse", "HEAD");
  git(work, "push", "origin", "moved-ref");
  assert.notEqual(advanced, base);

  assert.throws(
    () => deleteRemoteBranchWithLease({
      cwd: work,
      branch: "moved-ref",
      expectedSha: base,
    }),
    /stale info|failed|rejected/i,
  );
  assert.equal(
    remoteRef("refs/heads/moved-ref"),
    advanced,
    "stale lease rejection must leave moved remote ref intact",
  );

  assert.throws(
    () => deleteRemoteBranchWithLease({
      cwd: work,
      branch: "missing-ref",
      expectedSha: base,
    }),
    /remote ref does not exist|failed|unable to delete/i,
  );

  assert.throws(
    () => deleteRemoteBranchWithLease({
      cwd: work,
      branch: "moved-ref",
      expectedSha: "not-a-sha",
    }),
    /40-hex expected SHA/,
  );

  assert.throws(
    () => deleteRemoteBranchWithLease({
      cwd: work,
      branch: "-invalid",
      expectedSha: advanced,
    }),
    /check-ref-format failed|not a valid branch name|invalid/i,
  );

  console.log("#647 exact remote branch lease deletion passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
