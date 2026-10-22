import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOwnedMarkdownBlock } from "../dist/markdown-structure.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const runner = join(root, "dist/repo-guard.mjs");
const renderer = join(root, "scripts/self-host-docs.mjs");
const snapshotPaths = [
  "README.md", "RELEASING.md",
  "docs/self-hosting-coverage.json", "docs/self-hosting-coverage.md",
  ".repo-guard/projections.json", "scripts/self-host-docs.mjs",
];
const original = JSON.parse(read(".repo-guard/projections.json"));
const outputs = JSON.parse(execFileSync(process.execPath, [renderer, "--outputs"], {
  cwd: root, encoding: "utf8",
}));
const summary = original.entries.find((e) => e.model.target.ownership === "hybrid");
const generated = original.entries.find((e) => e.model.target.ownership === "generated");
assert.ok(summary && generated, "real self-host declares exactly HYBRID and GENERATED");
assert.equal(original.entries.length, 2);

function block(text) {
  const l = summary.model.target.locator;
  return readOwnedMarkdownBlock(text, {
    blockId: l.block_id, beginMarker: l.begin_marker, endMarker: l.end_marker,
  });
}
function removeBlock(text) {
  const b = block(text);
  assert.ok(b, "owned region must exist in real README");
  return text.slice(0, b.start) + text.slice(b.end);
}
function environment(fn) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-801-real-doc-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const put = (p, v) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), v);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=Self Host", "-c", "user.email=selfhost@example.invalid",
      "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const run = (command, base, head, supplied = outputs) => {
    const ephemeral = join(tmpdir(), "repo-guard-801-output-" + Date.now() + "-" + Math.random() + ".json");
    writeFileSync(ephemeral, JSON.stringify(supplied));
    let status = 0, out = "", error = "";
    try {
      out = execFileSync(process.execPath, [
        runner, "--repo-root", dir, command, "--base", base, "--head", head,
        ...(command === "build" ? ["--outputs", ephemeral] : ["--format", "json"]),
      ], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
    } catch (failure) {
      status = failure.status ?? 1;
      out = String(failure.stdout || "");
      error = String(failure.stderr || "");
    } finally { rmSync(ephemeral, { force: true }); }
    return { status, out, error, result: status === 0 ? JSON.parse(out) : null };
  };
  try {
    git("init", "-q");
    for (const p of snapshotPaths) put(p, read(p));
    return fn({ dir, git, put, commit, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("#801 actual self-host declaration + project renderer are synchronized and local", () => {
  assert.equal(readFileSync(renderer, "utf8").includes("node:http"), false);
  assert.equal(readFileSync(renderer, "utf8").includes("fetch("), false);
  assert.equal(JSON.stringify(JSON.parse(execFileSync(process.execPath, [renderer, "--state"], {
    cwd: root, encoding: "utf8",
  }))), JSON.stringify(original));
  assert.match(execFileSync(process.execPath, [renderer, "--check"], {
    cwd: root, encoding: "utf8",
  }), /CURRENT/);
  assert.equal(read(generated.model.target.path), outputs[generated.model.id]);
  assert.ok(block(read("README.md")));
  assert.equal(block(read("README.md")).content, [
    summary.model.target.locator.begin_marker,
    outputs[summary.model.id],
    summary.model.target.locator.end_marker,
  ].join("\n"));
});

test("#801 S1 S2 S3 S8: real SOURCE, HYBRID, GENERATED repair and replay using generic build", () => {
  for (const change of ["hybrid", "generated"]) {
    environment(({ dir, put, commit, run }) => {
      const originalReadme = read("README.md");
      const source = read("RELEASING.md");
      const originalGenerated = read(generated.model.target.path);
      const base = commit("real accepted RepoGuard docs");
      if (change === "hybrid") {
        put("README.md", originalReadme.replace(outputs[summary.model.id], "Stale managed region"));
      } else {
        put(generated.model.target.path, "Stale generated documentation\n");
      }
      const head = commit("real self-host drifted output");
      const observed = run("check", base, head);
      assert.notEqual(observed.status, 0, "stale target must not report CURRENT");
      const built = run("build", base, head);
      assert.equal(built.status, 0, built.error);
      assert.equal(readFileSync(join(dir, "README.md"), "utf8"), originalReadme);
      assert.equal(readFileSync(join(dir, generated.model.target.path), "utf8"), originalGenerated);
      assert.equal(readFileSync(join(dir, "RELEASING.md"), "utf8"), source);
      if (change === "hybrid") {
        assert.equal(removeBlock(readFileSync(join(dir, "README.md"), "utf8")), removeBlock(originalReadme));
      }
      const replay = run("build", base, head);
      assert.equal(replay.status, 0, replay.error);
      assert.equal(replay.result.idempotent, true);
    });
  }
});

test("#801 S4: real README orphan is detected then only exact region is removed", () => {
  environment(({ dir, put, commit, run }) => {
    const before = read("README.md");
    const base = commit("actual managed README");
    put(".repo-guard/projections.json", JSON.stringify({
      schema: original.schema, entries: [generated],
    }, null, 2) + "\n");
    const head = commit("retire exact README Projection writer");
    const red = run("check", base, head);
    assert.notEqual(red.status, 0);
    const result = run("build", base, head, { [generated.model.id]: outputs[generated.model.id] });
    assert.equal(result.status, 0, result.error);
    const after = readFileSync(join(dir, "README.md"), "utf8");
    assert.equal(after, removeBlock(before));
    assert.ok(after.includes("Новая блокирующая возможность"));
    assert.equal(readFileSync(join(dir, generated.model.target.path), "utf8"), read(generated.model.target.path));
    assert.equal(run("build", base, head, { [generated.model.id]: outputs[generated.model.id] }).result.idempotent, true);
  });
});

test("#801 S5: former real generated documentation is retained without a writer", () => {
  environment(({ dir, put, commit, run }) => {
    const base = commit("previously live coverage document");
    put(".repo-guard/projections.json", JSON.stringify({
      schema: original.schema, entries: [summary, { state: "retained", model: generated.model }],
    }, null, 2) + "\n");
    const head = commit("protect historical coverage document without live writer");
    const built = run("build", base, head, { [summary.model.id]: outputs[summary.model.id] });
    assert.equal(built.status, 0, built.error);
    assert.equal(built.result.idempotent, true);
    assert.equal(readFileSync(join(dir, generated.model.target.path), "utf8"), read(generated.model.target.path));
  });
});

test("#801 S6 S7: Requirement relation cannot write SOURCE; external renderer has no App/service", () => {
  environment(({ dir, git, put, commit, run }) => {
    const requirement = [
      "format: repo-guard/requirement-v1",
      "id: Q",
      "normative: Documentation relation grants no writer.",
      "relations:",
      "  - predicates: [documents]",
      "    target:",
      "      kind: artifact",
      '      path: "RELEASING.md"',
      "",
    ].join("\n");
    put("requirements/Q.rg.yaml", requirement);
    const head = commit("existing SOURCE documentation relation");
    const statusBefore = git("status", "--porcelain=v1");
    const bad = run("build", head, head, {
      ...outputs, "not-a-live-writer": "MALICIOUS",
    });
    assert.notEqual(bad.status, 0);
    assert.equal(readFileSync(join(dir, "RELEASING.md"), "utf8"), read("RELEASING.md"));
    assert.equal(git("status", "--porcelain=v1"), statusBefore);
    const valid = run("build", head, head);
    assert.equal(valid.status, 0, valid.error);
    assert.equal(valid.result.idempotent, true);
  });
});
