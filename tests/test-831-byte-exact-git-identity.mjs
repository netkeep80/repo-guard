import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileAtRef } from "../dist/git.mjs";
import {
  evaluateProjectionCheck,
  normalizeProjectionModel,
  projectionModelIdentity,
} from "../dist/projection-api.mjs";
import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=RepoGuard Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

test("#831 Git adapter preserves byte identity before projection hashing", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-831-byte-"));
  try {
    git(root, "init", "-q");
    const oldBytes = Buffer.from([0xef, 0xbf, 0xbd]);
    const newBytes = Buffer.from([0xff]);
    const output = Buffer.from("derived", "utf8");

    writeFileSync(join(root, "input.txt"), oldBytes);
    writeFileSync(join(root, "output.txt"), output);

    const model = normalizeProjectionModel({
      schema: "repo-guard/projection-model/v0",
      id: "binary-source",
      sources: [{
        id: "input",
        kind: "repository_content",
        path: "input.txt",
        algorithm: "sha256",
      }],
      target: { path: "output.txt", ownership: "generated" },
      generator: { contract_id: "renderer/v1" },
      required_evidence: [],
    });
    const build = {
      schema: "repo-guard/projection-build-record/v0",
      projection_id: model.id,
      model_identity: projectionModelIdentity(model),
      source_identities: [{
        source_id: "input",
        algorithm: "sha256",
        digest: sha256(oldBytes),
      }],
      generator: {
        contract_id: "renderer/v1",
        tool_identity: "renderer@1",
      },
      configuration_digest: sha256("config"),
      output_identity: {
        algorithm: "sha256",
        digest: sha256(output),
      },
      evidence: [],
    };
    const raw = JSON.stringify({
      schema: "repo-guard/projection-check/v0",
      entries: [{
        state: "live",
        model,
        build,
        current_generator: {
          tool_identity: "renderer@1",
          configuration_digest: sha256("config"),
        },
      }],
    });

    mkdirSync(join(root, ".repo-guard"));
    writeFileSync(join(root, ".repo-guard", "projections.json"), raw);
    const base = commit(root, "base");

    const evaluate = (revision, changed) => {
      const read = (path) => readFileAtRef(revision, path, root);
      return evaluateProjectionCheck({
        baseRaw: raw,
        headRaw: raw,
        readHead: read,
        facts: {
          readFile: read,
          diff: { files: { checked: changed ? [{ path: "input.txt", status: "modified" }] : [] } },
        },
      });
    };

    const baseReport = evaluate(base, false);
    assert.equal(baseReport.ok, true);
    assert.equal(baseReport.analyses[0].freshness, "CURRENT");

    writeFileSync(join(root, "input.txt"), newBytes);
    const head = commit(root, "head");
    assert.notEqual(sha256(oldBytes), sha256(newBytes));

    const headReport = evaluate(head, true);
    assert.equal(headReport.ok, false);
    assert.equal(headReport.analyses[0].freshness, "STALE");
    assert.ok(headReport.analyses[0].reasons.includes("source_changed:input"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#831 canonical textual Requirement rejects invalid UTF-8 from exact Git blob", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-831-utf8-"));
  try {
    git(root, "init", "-q");
    mkdirSync(join(root, "requirements"));
    const raw = Buffer.concat([
      Buffer.from("format: repo-guard/requirement-v1\nid: Q\nnormative: \"", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\"\n", "utf8"),
    ]);
    writeFileSync(join(root, "requirements", "Q.rg.yaml"), raw);
    const revision = commit(root, "invalid utf8");

    const result = loadCanonicalRequirements({
      repository: "audit/fixture",
      revision,
      paths: ["requirements/Q.rg.yaml"],
      readFile: (sha, path) => readFileAtRef(sha, path, root),
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "invalid_canonical_source");
    assert.match(result.errors[0]?.message || "", /valid UTF-8/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
