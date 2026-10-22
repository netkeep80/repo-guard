import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeProjectionModel, projectionModelIdentity } from "../dist/projection-model.mjs";
import { replaceOwnedMarkdownBlock, readOwnedMarkdownBlock } from "../dist/markdown-structure.mjs";
import { evaluateProjectionCheck } from "../dist/projection-check.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const cli = new URL("../dist/repo-guard.mjs", import.meta.url).pathname;
const newline = "\n";
function model(id, target) {
  return normalizeProjectionModel({ schema: "repo-guard/projection-model/v0", id,
    sources: [{ id: "input", kind: "repository_content", path: "input.txt", algorithm: "sha256" }],
    target, generator: { contract_id: "renderer/v1" }, required_evidence: [] });
}
const markers = (anchor = "root", block = "x") => ({
  kind: "markdown_owned_block", anchor_id: anchor, block_id: block,
  begin_marker: "<!-- owned:" + block + ":start -->",
  end_marker: "<!-- owned:" + block + ":end -->",
});
const hybrid = (id, anchor, block) => model(id, {
  path: "docs/story.md", ownership: "hybrid", locator: markers(anchor, block),
});
const generated = (id, path = "docs/output.txt") => model(id, { path, ownership: "generated" });
function built(model, payload, input = "seed\n") {
  return { schema: "repo-guard/projection-build-record/v0", projection_id: model.id,
    model_identity: projectionModelIdentity(model),
    source_identities: [{ source_id: "input", algorithm: "sha256", digest: sha(input) }],
    generator: { contract_id: "renderer/v1", tool_identity: "renderer@1" },
    configuration_digest: sha("config"),
    output_identity: { algorithm: "sha256", digest: sha(payload) }, evidence: [] };
}
const entry = (model, payload) => ({
  state: "live", model, build: built(model, payload),
  current_generator: { tool_identity: "renderer@1", configuration_digest: sha("config") },
});
const state = (entries) => JSON.stringify({ schema: "repo-guard/projection-check/v0", entries }, null, 2) + "\n";
function environment(fn) {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-800-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (p, v) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), v); };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=Projection Fixture", "-c", "user.email=projection@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const build = (base, head, outputs = {}) => {
    const payload = join(tmpdir(), "projection-output-" + Date.now() + "-" + Math.random() + ".json");
    writeFileSync(payload, JSON.stringify(outputs));
    let stdout = "", status = 0, stderr = "";
    try {
      stdout = execFileSync(process.execPath, [cli, "--repo-root", root, "build",
        "--base", base, "--head", head, "--outputs", payload], {
        cwd: root, encoding: "utf8", env: { PATH: process.env.PATH },
      });
    } catch (error) {
      status = error.status ?? 1;
      stdout = String(error.stdout || "");
      stderr = String(error.stderr || "");
    } finally { rmSync(payload, { force: true }); }
    return { status, stdout, stderr, result: status === 0 ? JSON.parse(stdout) : null };
  };
  try {
    git("init", "-q");
    put("input.txt", "seed\n");
    return fn({ root, git, put, commit, build });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function content(model, source, payload) {
  const target = replaceOwnedMarkdownBlock({
    source, mode: "hybrid", anchorId: model.target.locator.anchor_id,
    block: { blockId: model.target.locator.block_id,
      beginMarker: model.target.locator.begin_marker, endMarker: model.target.locator.end_marker },
    generatedContent: payload,
  });
  const block = readOwnedMarkdownBlock(target, {
    blockId: model.target.locator.block_id,
    beginMarker: model.target.locator.begin_marker, endMarker: model.target.locator.end_marker,
  });
  assert.ok(block);
  return { target, fragment: block.content };
}

test("#800 W1 W2 W11 W12: HYBRID add/update and LF CRLF Unicode EOF exact preservation", () => {
  for (const eol of ["\n", "\r\n"]) {
    for (const eof of ["", eol]) {
      environment(({ root, put, commit, build }) => {
        const m = hybrid("h.one", "root", "x");
        const authored = ['<a id="root"></a>', "# Заголовок", "Авторский текст 🎓",
          "", "Нижний авторский текст"].join(eol) + eof;
        const region = content(m, authored, "GEN-1");
        put("docs/story.md", authored);
        put(".repo-guard/projections.json", state([entry(m, region.fragment)]));
        const base = commit("hybrid insertion fixture");
        const result = build(base, base, { [m.id]: "GEN-1" });
        assert.equal(result.status, 0, result.stderr);
        const expected = region.target;
        assert.deepEqual(readFileSync(join(root, "docs/story.md")), Buffer.from(expected));
        const replay = build(base, base, { [m.id]: "GEN-1" });
        assert.equal(replay.status, 0, replay.stderr);
        assert.equal(replay.result.idempotent, true);
        commit("accept generated block");
        const next = content(m, expected, "GEN-2");
        put(".repo-guard/projections.json", state([entry(m, next.fragment)]));
        const updateHead = commit("change deterministic renderer output identity");
        const update = build(base, updateHead, { [m.id]: "GEN-2" });
        assert.equal(update.status, 0, update.stderr);
        assert.deepEqual(readFileSync(join(root, "docs/story.md")), Buffer.from(next.target));
        assert.ok(next.target.startsWith(expected.slice(0, expected.indexOf(m.target.locator.begin_marker))));
        assert.ok(next.target.endsWith("Нижний авторский текст" + eof));
      });
    }
  }
});

test("#800 W3 W4 W5: BASE orphan cleanup, retained and explicit SOURCE handoff", () => {
  for (const transition of ["orphan", "retained", "source"]) {
    environment(({ root, put, commit, build }) => {
      const m = hybrid("h.orphan", "root", "x");
      const authored = '<a id="root"></a>\n# Root\nPreamble ☀️\n\nAfter.\n';
      const before = content(m, authored, "FORMER");
      put("docs/story.md", before.target);
      const baseRaw = state([entry(m, before.fragment)]);
      put(".repo-guard/projections.json", baseRaw);
      const base = commit("accepted BASE-owned hybrid");
      const nextEntries = transition === "orphan" ? [] : [{ state: transition, model: m }];
      const headRaw = state(nextEntries);
      put(".repo-guard/projections.json", headRaw);
      const head = commit("HEAD conversion " + transition);
      const result = build(base, head, {});
      assert.equal(result.status, 0, result.stderr);
      const actual = readFileSync(join(root, "docs/story.md"), "utf8");
      if (transition === "orphan") {
        assert.ok(!actual.includes(m.target.locator.begin_marker));
        assert.ok(actual.includes("Preamble ☀️"));
        assert.ok(actual.includes("After."));
      } else {
        assert.equal(actual, before.target, transition + " preserves complete authored bytes");
      }
      if (transition === "source") {
        const report = evaluateProjectionCheck({
          baseRaw, headRaw, readHead: (p) => p === "docs/story.md" ? actual : null,
          facts: { readFile: (p) => p === "docs/story.md" ? actual : null, diff: { files: { checked: [] } } },
        });
        assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
        assert.deepEqual(report.ownership.orphan, []);
      }
    });
  }
});

test("#800 W6 W12: GENERATED one-writer replacement and idempotence", () => {
  environment(({ root, put, commit, build }) => {
    const m = generated("g.one");
    put("docs/output.txt", "OLD");
    put(".repo-guard/projections.json", state([entry(m, "NEW")]));
    const head = commit("replace generated target");
    const first = build(head, head, { [m.id]: "NEW" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(root, "docs/output.txt"), "utf8"), "NEW");
    assert.equal(build(head, head, { [m.id]: "NEW" }).result.idempotent, true);
  });
});

test("#800 W7 W8 W9: invalid ownership fails before any file mutation", () => {
  for (const mode of ["two-writers", "overlap", "sibling"]) {
    environment(({ root, put, commit, build }) => {
      const first = hybrid("h.a", "root", "a");
      const second = mode === "two-writers" ? hybrid("h.b", "root", "a")
        : hybrid("h.b", "root", "b");
      let text = '<a id="root"></a>\n# Root\n';
      if (mode === "overlap") {
        text += "<!-- owned:a:start -->\nA\n<!-- owned:b:start -->\nB\n<!-- owned:a:end -->\nC\n<!-- owned:b:end -->\n";
      } else if (mode === "sibling") {
        text += '<a id="wrong"></a>\n# Wrong\n<!-- owned:b:start -->\nB\n<!-- owned:b:end -->\n';
      } else {
        text += "<!-- owned:a:start -->\nA\n<!-- owned:a:end -->\n";
      }
      put("docs/story.md", text);
      put(".repo-guard/projections.json", state([entry(first, "bogus"), entry(second, "bogus")]));
      const head = commit("invalid ownership " + mode);
      const result = build(head, head, { [first.id]: "changed", [second.id]: "changed" });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(root, "docs/story.md"), "utf8"), text);
      assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }), "");
    });
  }
});

test("#800 W10: symlink and Git submodule are never writable", () => {
  for (const kind of ["symlink", "submodule"]) {
    environment(({ root, git, put, commit, build }) => {
      const m = generated("g.unsafe", "docs/output.txt");
      put(".repo-guard/projections.json", state([entry(m, "NEW")]));
      if (kind === "symlink") {
        put("docs/actual.txt", "SAFE");
        symlinkSync("actual.txt", join(root, "docs/output.txt"));
        const head = commit("symlink target");
        const result = build(head, head, { [m.id]: "NEW" });
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(join(root, "docs/actual.txt"), "utf8"), "SAFE");
      } else {
        const existing = commit("submodule commit object");
        git("update-index", "--add", "--cacheinfo", "160000," + existing + ",docs/output.txt");
        git("-c", "user.name=Projection Fixture", "-c", "user.email=projection@example.invalid", "commit", "-qm", "submodule target");
        const head = git("rev-parse", "HEAD");
        const result = build(head, head, { [m.id]: "NEW" });
        assert.notEqual(result.status, 0);
      }
    });
  }
});

test("#800 W10b: submodule ancestor and local .git metadata are never materialization targets", () => {
  for (const target of ["deps/lib/derived.txt", ".git/private-data"]) {
    environment(({ root, git, put, commit, build }) => {
      const modelTarget = generated("g.prefix", target);
      put(".repo-guard/projections.json", state([entry(modelTarget, "UNSAFE")]));
      let revision = commit("versioned attempted output");
      if (target.startsWith("deps/")) {
        git("update-index", "--add", "--cacheinfo", "160000," + revision + ",deps/lib");
        git("-c", "user.name=Projection Fixture", "-c", "user.email=projection@example.invalid",
          "commit", "-qm", "add Git submodule parent");
        revision = git("rev-parse", "HEAD");
      }
      const statusBefore = git("status", "--porcelain=v1");
      const result = build(revision, revision, { [modelTarget.id]: "UNSAFE" });
      assert.notEqual(result.status, 0, "unsupported parent must fail closed");
      assert.ok(!readFileSync(join(root, ".git/HEAD"), "utf8").includes("UNSAFE"));
      assert.equal(git("status", "--porcelain=v1"), statusBefore, "RED must not mutate the checkout");
    });
  }
});

test("#800 W13 W14: removing a Requirement never deletes a live-owned output; no network required", () => {
  environment(({ root, git, put, commit, build }) => {
    const m = generated("g.shared");
    const req = (id) => ['format: repo-guard/requirement-v1', 'id: ' + id,
      'normative: keep output', 'relations:', '  - predicates: [documents]',
      '    target:', '      kind: artifact', '      path: "docs/output.txt"', ""].join("\n");

    put("docs/output.txt", "GEN");
    put(".repo-guard/projections.json", state([entry(m, "GEN")]));
    put("requirements/A.rg.yaml", req("A"));
    put("requirements/B.rg.yaml", req("B"));
    const base = commit("two Requirements refer to a live-owned generated output");

    rmSync(join(root, "requirements/A.rg.yaml"));
    const head = commit("remove one Requirement; Projection stays live");
    const result = build(base, head, { [m.id]: "GEN" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.result.idempotent, true);
    assert.equal(readFileSync(join(root, "docs/output.txt"), "utf8"), "GEN");
    assert.equal(git("status", "--porcelain=v1"), "");
  });
});

test("#800 orphan cleanup follows BASE Projection ownership, never Requirement traceability", () => {
  environment(({ root, put, commit, build }) => {
    const m = generated("g.orphan");
    const req = ['format: repo-guard/requirement-v1', 'id: Q',
      'normative: points to output', 'relations:', '  - predicates: [documents]',
      '    target:', '      kind: artifact', '      path: "docs/output.txt"', ""].join("\n");
    put("docs/output.txt", "GEN");
    put("requirements/Q.rg.yaml", req);
    put(".repo-guard/projections.json", state([entry(m, "GEN")]));
    const base = commit("accepted generated output with Requirement traceability");

    // Only removing the explicit BASE writer makes this output an orphan.
    // A still-present Requirement relation is neither writer authority nor a cleanup veto.
    put(".repo-guard/projections.json", state([]));
    const head = commit("remove old Projection writer, keep unrelated documents relation");
    const result = build(base, head, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, "docs/output.txt")), false);
    const repeat = build(base, head, {});
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(repeat.result.idempotent, true);
  });
});
