import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { loadCanonicalRequirements } from "../dist/runtime/canonical-requirements.mjs";
import { evaluateRootedRequirements } from "../dist/runtime/requirement-closure.mjs";
import { createResourceResolver } from "../dist/runtime/resource-resolver.mjs";
import { evaluateTrackedResourceClosure } from "../dist/runtime/resource-closure.mjs";
import { evaluateLocalCompiler } from "../dist/local-compiler.mjs";

const repository = "fixture/collection";
const revision = "a".repeat(40);
const SCHEMA = "repo-guard/resource-collection/v0";
const manifest = (members, extra = {}) => JSON.stringify({ schema: SCHEMA, members, ...extra }, null, 2) + "\n";

function canonicalRequirement(id, manifestPath, { collection = true } = {}) {
  return {
    id,
    relations: {
      verify: {
        predicate: "verified_by",
        target: { kind: "artifact", path: manifestPath },
        ...(collection ? { collection: true } : {}),
      },
    },
  };
}

function closure({ docs, files, roots }) {
  const requirementPaths = docs.map((doc) => `requirements/${doc.id}.json`);
  const requirements = loadCanonicalRequirements({
    repository,
    revision,
    paths: requirementPaths,
    readFile: (_, path) => {
      const index = requirementPaths.indexOf(path);
      return index >= 0 ? JSON.stringify(docs[index]) : null;
    },
  });
  const trustedRoots = roots.map((id) => requirements.index[id].semantic);
  const j2 = evaluateRootedRequirements({ requirements, trustedRoots });
  const trackedPaths = [...requirementPaths, ...files.keys()].sort();
  const resolver = createResourceResolver({
    repository,
    revision,
    requirements,
    readers: {
      [repository]: (sha, path) => sha === revision ? files.get(path) ?? null : null,
    },
  });
  return evaluateTrackedResourceClosure({
    repository,
    revision,
    requirements,
    j2,
    trackedPaths,
    resolver,
  });
}

test("#814 G1/G2 exact bounded collection owns independently authored members", () => {
  const files = new Map([
    ["inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"])],
    ["tests/a.test.ts", "export const a = 1;\n"],
    ["tests/b.test.ts", "export const b = 1;\n"],
  ]);
  const result = closure({
    docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
    files,
    roots: ["R"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.owners["tests/a.test.ts"], ["R"]);
  assert.deepEqual(result.owners["tests/b.test.ts"], ["R"]);
  assert.ok(result.explanations["tests/a.test.ts"].includes("collection:" + SCHEMA));
  assert.ok(result.explanations["tests/a.test.ts"].includes("member:tests/a.test.ts"));
  assert.equal(result.explanations["tests/a.test.ts"].some((item) => item.startsWith("generates:")), false);
});

test("#814 G3 shared ownership is deterministic", () => {
  const files = new Map([
    ["inventory/a.resources.json", manifest(["tests/shared.test.ts"])],
    ["inventory/b.resources.json", manifest(["tests/shared.test.ts"])],
    ["tests/shared.test.ts", "shared\n"],
  ]);
  const result = closure({
    docs: [
      canonicalRequirement("R1", "inventory/a.resources.json"),
      canonicalRequirement("R2", "inventory/b.resources.json"),
    ],
    files,
    roots: ["R1", "R2"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.owners["tests/shared.test.ts"], ["R1", "R2"]);
});

test("#814 N1 unlisted neighbor remains unjustified", () => {
  const files = new Map([
    ["inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"])],
    ["tests/a.test.ts", "a\n"],
    ["tests/b.test.ts", "b\n"],
    ["tests/orphan.test.ts", "orphan\n"],
  ]);
  const result = closure({
    docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
    files,
    roots: ["R"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unjustified, ["tests/orphan.test.ts"]);
});

test("#814 N2/N3 missing unsafe wildcard alias and directory members fail closed", () => {
  for (const [label, member] of [
    ["missing", "tests/missing.test.ts"],
    ["empty", ""],
    ["wildcard", "tests/**"],
    ["alias", "tests/../tests/a.test.ts"],
    ["directory", "tests/"],
  ]) {
    const files = new Map([
      ["inventory/tests.resources.json", manifest([member])],
      ["tests/a.test.ts", "a\n"],
    ]);
    const result = closure({
      docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
      files,
      roots: ["R"],
    });
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((error) =>
      ["invalid_resource_collection", "missing_resource_target"].includes(error.code)), label);
  }
});

test("#814 N4 duplicate unsorted malformed and non-string members fail closed", () => {
  const cases = [
    ["duplicate", manifest(["tests/a.test.ts", "tests/a.test.ts"])],
    ["unsorted", manifest(["tests/b.test.ts", "tests/a.test.ts"])],
    ["non-string", JSON.stringify({ schema: SCHEMA, members: ["tests/a.test.ts", null] })],
    ["malformed", `{"schema":"${SCHEMA}","members":[`],
    ["duplicate-key", `{"schema":"${SCHEMA}","schema":"${SCHEMA}","members":[]}`],
  ];
  for (const [label, body] of cases) {
    const files = new Map([
      ["inventory/tests.resources.json", body],
      ["tests/a.test.ts", "a\n"],
      ["tests/b.test.ts", "b\n"],
    ]);
    const result = closure({
      docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
      files,
      roots: ["R"],
    });
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((error) => error.code === "invalid_resource_collection"), label);
  }
});

test("#814 N5 anti-downgrade: collection:true requires exact closed manifest schema", () => {
  const invalid = [
    ["wrong-schema", JSON.stringify({ schema: "other/v0", members: [] })],
    ["missing-members", JSON.stringify({ schema: SCHEMA })],
    ["extra-field", JSON.stringify({ schema: SCHEMA, members: [], allow: true })],
  ];
  for (const [label, body] of invalid) {
    const files = new Map([["inventory/tests.resources.json", body]]);
    const result = closure({
      docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
      files,
      roots: ["R"],
    });
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((error) => error.code === "invalid_resource_collection"), label);
  }

  const ordinary = closure({
    docs: [canonicalRequirement("R", "inventory/plain.json", { collection: false })],
    files: new Map([["inventory/plain.json", "{ definitely-not-json\n"]]),
    roots: ["R"],
  });
  assert.equal(ordinary.ok, true, "collection absent/false preserves ordinary Artifact semantics");
});

test("#814 N6 self/nested collection membership is rejected", () => {
  const self = closure({
    docs: [canonicalRequirement("R", "inventory/a.resources.json")],
    files: new Map([["inventory/a.resources.json", manifest(["inventory/a.resources.json"])]]),
    roots: ["R"],
  });
  assert.equal(self.ok, false);
  assert.ok(self.errors.some((error) => error.code === "nested_resource_collection"));

  const nested = closure({
    docs: [canonicalRequirement("R", "inventory/a.resources.json")],
    files: new Map([
      ["inventory/a.resources.json", manifest(["inventory/b.resources.json"])],
      ["inventory/b.resources.json", manifest([])],
    ]),
    roots: ["R"],
  });
  assert.equal(nested.ok, false);
  assert.ok(nested.errors.some((error) => error.code === "nested_resource_collection"));
});

test("#814 N7 disconnected typed manifest grants no ownership", () => {
  const files = new Map([
    ["inventory/tests.resources.json", manifest(["tests/a.test.ts"])],
    ["tests/a.test.ts", "a\n"],
  ]);
  const result = closure({ docs: [{ id: "R" }], files, roots: ["R"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unjustified, ["inventory/tests.resources.json", "tests/a.test.ts"]);
});

test("#814 N8 missing manifest target remains RED", () => {
  const result = closure({
    docs: [canonicalRequirement("R", "inventory/missing.resources.json")],
    files: new Map(),
    roots: ["R"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.code === "missing_resource_target" && error.target === "inventory/missing.resources.json"));
});

function nativeRequirement({ manifestPath, maxChangedResources, direct = [] }) {
  const constraint = maxChangedResources === undefined ? "" : `
constraints:
  - id: verifier-scope
    scope:
      relations: [verified_by]
    metric:
      key: git.changed_resources
      max: ${maxChangedResources}
`;
  const directRelations = direct.map((path) => `  - predicates: [verified_by]
    target:
      kind: artifact
      path: "${path}"
`).join("");
  return `format: repo-guard/requirement-v1
id: VERIFY
normative: "generic verifier family"
relations:
  - predicates: [verified_by]
    target:
      kind: artifact
      path: "${manifestPath}"
    collection: true
${directRelations}${constraint}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-814-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=#814", "-c", "user.email=814@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  return {
    root, git, put, commit,
    evaluate: (base, head) => evaluateLocalCompiler({ root, repository, base, head }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("#814 G4/N9 add Resource is causal only when exact membership is added", () => {
  const f = fixture();
  try {
    f.put("requirements/verify.rg.yaml", nativeRequirement({ manifestPath: "inventory/tests.resources.json" }));
    f.put("inventory/tests.resources.json", manifest(["tests/a.test.ts"]));
    f.put("tests/a.test.ts", "a\n");
    const base = f.commit("base exact collection");
    assert.equal(f.evaluate(base, base).ok, true);

    f.put("tests/b.test.ts", "b\n");
    const orphan = f.commit("add unlisted verifier");
    assert.equal(f.evaluate(base, orphan).ok, false, "N9 unlisted new Resource must be RED");

    f.put("inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"]));
    const head = f.commit("add exact member");
    const green = f.evaluate(base, head);
    assert.equal(green.ok, true, "G4 Resource + exact membership must be GREEN");
    assert.ok(green.j3.affectedRequirements.includes("VERIFY"));
  } finally {
    f.cleanup();
  }
});

test("#814 G5/N10 removed membership is GREEN only with another honest owner", () => {
  const red = fixture();
  try {
    red.put("requirements/verify.rg.yaml", nativeRequirement({ manifestPath: "inventory/tests.resources.json" }));
    red.put("inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"]));
    red.put("tests/a.test.ts", "a\n");
    red.put("tests/b.test.ts", "b\n");
    const base = red.commit("base");
    red.put("inventory/tests.resources.json", manifest(["tests/a.test.ts"]));
    const head = red.commit("remove last member ownership");
    assert.equal(red.evaluate(base, head).ok, false, "N10 last owner removal while file remains is RED");
  } finally {
    red.cleanup();
  }

  const green = fixture();
  try {
    green.put("requirements/verify.rg.yaml", nativeRequirement({
      manifestPath: "inventory/tests.resources.json",
      direct: ["tests/b.test.ts"],
    }));
    green.put("inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"]));
    green.put("tests/a.test.ts", "a\n");
    green.put("tests/b.test.ts", "b\n");
    const base = green.commit("base shared cause");
    green.put("inventory/tests.resources.json", manifest(["tests/a.test.ts"]));
    const head = green.commit("remove collection ownership but keep direct owner");
    assert.equal(green.evaluate(base, head).ok, true, "G5 another honest owner prevents false cochange");
  } finally {
    green.cleanup();
  }
});

test("#814 N13 scoped Constraint reaches exact collection members but not neighbors", () => {
  const f = fixture();
  try {
    f.put("requirements/verify.rg.yaml", nativeRequirement({
      manifestPath: "inventory/tests.resources.json",
      maxChangedResources: 0,
    }));
    f.put("inventory/tests.resources.json", manifest(["tests/a.test.ts", "tests/b.test.ts"]));
    f.put("tests/a.test.ts", "a\n");
    f.put("tests/b.test.ts", "b\n");
    const base = f.commit("constraint base");
    f.put("tests/b.test.ts", "changed\n");
    const head = f.commit("change exact member");
    const result = f.evaluate(base, head);
    assert.equal(result.ok, false);
    const scope = result.j3.constraints.find((item) =>
      item.requirementId === "VERIFY" && item.constraintId === "verifier-scope");
    assert.ok(scope?.scope.includes("inventory/tests.resources.json"));
    assert.ok(scope?.scope.includes("tests/a.test.ts"));
    assert.ok(scope?.scope.includes("tests/b.test.ts"));
    assert.equal(scope?.scope.includes("tests/orphan.test.ts"), false);
  } finally {
    f.cleanup();
  }
});

test("#814 N11 wrong-revision member resolution fails closed", () => {
  const doc = canonicalRequirement("R", "inventory/tests.resources.json");
  const requirementPath = "requirements/R.json";
  const requirements = loadCanonicalRequirements({
    repository,
    revision,
    paths: [requirementPath],
    readFile: (_, path) => path === requirementPath ? JSON.stringify(doc) : null,
  });
  const j2 = evaluateRootedRequirements({
    requirements,
    trustedRoots: [requirements.index.R.semantic],
  });
  const wrongRevision = "b".repeat(40);
  const resolver = {
    resolve(ref) {
      const value = ref && typeof ref === "object" ? ref : null;
      if (value?.kind !== "artifact" || typeof value.path !== "string") return { ok: false };
      const path = value.path;
      if (path === "inventory/tests.resources.json") return {
        ok: true,
        value: {
          kind: "resolved_artifact",
          representation: { repository, revision, path },
          bytes: manifest(["tests/a.test.ts"]),
        },
      };
      if (path === "tests/a.test.ts") return {
        ok: true,
        value: {
          kind: "resolved_artifact",
          representation: { repository, revision: wrongRevision, path },
          bytes: "wrong revision\n",
        },
      };
      return { ok: false };
    },
  };
  const result = evaluateTrackedResourceClosure({
    repository,
    revision,
    requirements,
    j2,
    trackedPaths: [requirementPath, "inventory/tests.resources.json", "tests/a.test.ts"],
    resolver,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.code === "missing_resource_target" && error.target === "tests/a.test.ts"));
});

test("#814 N11/N14 exact snapshot ignores working tree and verdict is deterministic offline", () => {
  const f = fixture();
  try {
    f.put("requirements/verify.rg.yaml", nativeRequirement({ manifestPath: "inventory/tests.resources.json" }));
    f.put("inventory/tests.resources.json", manifest(["tests/a.test.ts"]));
    f.put("tests/a.test.ts", "committed\n");
    const base = f.commit("snapshot");
    const first = f.evaluate(base, base);
    f.put("tests/a.test.ts", "working-tree-only\n");
    f.put("tests/untracked.test.ts", "untracked\n");
    const second = f.evaluate(base, base);
    assert.deepEqual(second, first, "same exact BASE/HEAD must ignore working-tree-only state");
    assert.equal(second.ok, true);
  } finally {
    f.cleanup();
  }
});

test("#831 invalid UTF-8 collection manifest cannot alias a valid U+FFFD member path", () => {
  const aliasedMember = "tests/\uFFFD.test.ts";
  const malformedManifest = Buffer.concat([
    Buffer.from(`{"schema":"${SCHEMA}","members":["tests/`, "utf8"),
    Buffer.from([0xff]),
    Buffer.from('.test.ts"]}\n', "utf8"),
  ]);
  const result = closure({
    docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
    files: new Map([
      ["inventory/tests.resources.json", malformedManifest],
      [aliasedMember, "valid member\n"],
    ]),
    roots: ["R"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.code === "invalid_resource_collection" &&
    error.target === "inventory/tests.resources.json"));
  assert.equal(result.owners[aliasedMember], undefined);
});

test("#831 binary collection member remains opaque when probed for nested collection schema", () => {
  const result = closure({
    docs: [canonicalRequirement("R", "inventory/tests.resources.json")],
    files: new Map([
      ["inventory/tests.resources.json", manifest(["bin/payload.bin"])],
      ["bin/payload.bin", Buffer.from([0xff, 0x00, 0x01])],
    ]),
    roots: ["R"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.owners["bin/payload.bin"], ["R"]);
});

console.log("#814 bounded exact Resource Collection fixtures loaded");
