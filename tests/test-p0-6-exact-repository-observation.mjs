import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  acquirePullRequestObservation,
  listTrackedFilesAtRef,
  readFileAtRef,
} from "../dist/git.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha = (cwd, ref) => git(cwd, "rev-parse", `${ref}^{commit}`);
const tree = (cwd, ref) => git(cwd, "rev-parse", `${ref}^{tree}`);

function write(root, path, content) {
  mkdirSync(resolve(root, path, ".."), { recursive: true });
  writeFileSync(resolve(root, path), content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rg-p06-observation-"));
  const remote = join(root, "remote.git"), seed = join(root, "seed"), worker = join(root, "worker");
  mkdirSync(seed);
  git(root, "init", "--bare", remote);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "test@test.com");
  git(seed, "config", "user.name", "Test");
  write(seed, "repo-policy.json", JSON.stringify({ policy_format_version: "0.3.0", repository_kind: "library", paths: { forbidden: [], canonical_docs: [], governance_paths: [] }, diff_rules: { max_new_docs: 10, max_new_files: 10, max_net_added_lines: 1000 }, content_rules: [], cochange_rules: [] }));
  write(seed, "base.txt", "base-0\n");
  git(seed, "add", "-A"); git(seed, "commit", "-m", "base0");
  const eventBase = sha(seed, "HEAD");
  git(seed, "remote", "add", "origin", remote); git(seed, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  git(seed, "switch", "-c", "feature");
  write(seed, "feature.txt", "feature-head\n");
  git(seed, "add", "-A"); git(seed, "commit", "-m", "feature");
  const head = sha(seed, "HEAD");
  git(seed, "push", "origin", "feature");

  git(root, "clone", "-b", "main", remote, worker);
  git(worker, "config", "user.email", "test@test.com");
  git(worker, "config", "user.name", "Test");
  git(worker, "fetch", "origin", "feature");
  assert.equal(sha(worker, "refs/remotes/origin/main"), eventBase);

  git(seed, "switch", "main");
  write(seed, "base.txt", "base-1\n");
  write(seed, "base-only.txt", "advanced-base\n");
  git(seed, "add", "-A"); git(seed, "commit", "-m", "base1");
  const currentBase = sha(seed, "HEAD");
  git(seed, "push", "origin", "main");

  git(worker, "checkout", "--detach", head);
  return { root, remote, seed, worker, eventBase, currentBase, head };
}

function observe(f) {
  return acquirePullRequestObservation({
    repository: "owner/repo",
    baseRef: "main",
    eventBaseSha: f.eventBase,
    headSha: f.head,
    cwd: f.worker,
    remote: "origin",
  });
}

describe("P0.6 exact repository observation", () => {
  it("refreshes stale BASE evidence and identifies immutable B/M/H/T", () => {
    const f = fixture();
    try {
      assert.equal(sha(f.worker, "refs/remotes/origin/main"), f.eventBase, "fixture must start with stale origin/main");
      const observation = observe(f);
      assert.equal(observation.contract, "exact_head");
      assert.equal(observation.repository, "owner/repo");
      assert.equal(observation.source, "github_pull_request");
      assert.match(observation.observed_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(observation.base.ref, "main");
      assert.equal(observation.base.event_sha, f.eventBase);
      assert.equal(observation.base.sha, f.currentBase);
      assert.equal(observation.base.advanced_since_event, true);
      assert.equal(observation.merge_base.sha, f.eventBase);
      assert.equal(observation.head.sha, f.head);
      assert.equal(observation.evaluated.commit_sha, f.head);
      assert.equal(observation.evaluated.tree_sha, tree(f.worker, f.head));
      assert.equal(observation.base.tree_sha, tree(f.worker, f.currentBase));
      assert.equal(observation.merge_base.tree_sha, tree(f.worker, f.eventBase));
      assert.equal(observation.head.tree_sha, tree(f.worker, f.head));
      assert.equal(observation.checkout.commit_sha, f.head);
      assert.equal(observation.checkout.matches_head, true);
      assert.equal(observation.checkout.dirty, false);
      assert.equal(observation.cache_key, `owner/repo:${tree(f.worker, f.head)}`);
      assert.equal(observation.cache_key.includes("HEAD"), false);
      assert.equal(observation.cache_key.includes("main"), false);
      assert.equal(sha(f.worker, "refs/remotes/origin/main"), f.currentBase, "observation must explicitly refresh base evidence");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("does not let a synthetic merge checkout masquerade as exact H/T", () => {
    const f = fixture();
    try {
      observe(f); // refresh origin/main first
      git(f.worker, "checkout", "--detach", f.head);
      git(f.worker, "merge", "--no-ff", "--no-edit", "refs/remotes/origin/main");
      const mergeCommit = sha(f.worker, "HEAD"), mergeTree = tree(f.worker, "HEAD");
      const observation = observe(f);
      assert.equal(observation.checkout.commit_sha, mergeCommit);
      assert.equal(observation.checkout.tree_sha, mergeTree);
      assert.equal(observation.checkout.matches_head, false);
      assert.equal(observation.evaluated.commit_sha, f.head);
      assert.equal(observation.evaluated.tree_sha, tree(f.worker, f.head));
      assert.notEqual(observation.checkout.tree_sha, observation.evaluated.tree_sha);
      assert.equal(readFileAtRef(observation.evaluated.commit_sha, "feature.txt", f.worker), "feature-head\n");
      assert.equal(listTrackedFilesAtRef(observation.evaluated.commit_sha, f.worker).includes("base-only.txt"), false,
        "base-only merge-tree content must not enter exact-head state evaluation");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("reports dirty/unrelated checkout state without changing evaluated H", () => {
    const f = fixture();
    try {
      observe(f);
      git(f.worker, "checkout", "--detach", f.currentBase);
      write(f.worker, "unrelated-local.txt", "dirty\n");
      const observation = observe(f);
      assert.equal(observation.checkout.commit_sha, f.currentBase);
      assert.equal(observation.checkout.matches_head, false);
      assert.equal(observation.checkout.dirty, true);
      assert.equal(observation.evaluated.commit_sha, f.head);
      assert.equal(listTrackedFilesAtRef(f.head, f.worker).includes("unrelated-local.txt"), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("fails closed with a stable reason when B and H have no merge base", () => {
    const f = fixture();
    try {
      git(f.worker, "checkout", "--orphan", "unrelated");
      git(f.worker, "rm", "-rf", ".");
      write(f.worker, "unrelated.txt", "orphan\n");
      git(f.worker, "add", "-A"); git(f.worker, "commit", "-m", "orphan");
      const unrelated = sha(f.worker, "HEAD");
      assert.throws(() => acquirePullRequestObservation({
        repository: "owner/repo", baseRef: "main", eventBaseSha: f.eventBase, headSha: unrelated, cwd: f.worker, remote: "origin",
      }), /repository observation failed: missing merge base/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
