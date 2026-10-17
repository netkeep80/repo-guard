import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../dist/document-facts.mjs";
import { checkRequirementTransition, normalizeRequirementAuthority } from "../dist/requirement-relations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedIds = [
  "RG-01", "RG-02", "RG-03", "RG-04", "RG-05", "RG-06", "RG-07", "RG-08",
];
const requirementPaths = expectedIds.map((id) => `requirements/repo-guard/${id}.yaml`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.match(revision, /^[0-9a-f]{40}$/);

const productRequirements = readFileSync(resolve(root, "docs/product-requirements.md"), "utf8");
for (const id of expectedIds) {
  assert.match(productRequirements, new RegExp(`^### ${id}\\b`, "m"), `${id}: semantic authority heading missing`);
}

const sources = requirementPaths.map((path, index) => {
  const content = readFileSync(resolve(root, path), "utf8");
  const parsed = parseYaml(content);
  assert.deepEqual(Object.keys(parsed).sort(), ["artifacts", "id"], `${path}: relation source must stay prose-free`);
  assert.equal(parsed.id, expectedIds[index]);
  assert.ok(Array.isArray(parsed.artifacts));
  for (const artifact of parsed.artifacts) {
    assert.deepEqual(Object.keys(artifact).sort(), ["path", "relations"], `${path}: artifact entry must contain only path + relations`);
  }
  return { path, format: "yaml", content };
});

const graph = normalizeRequirementAuthority({
  snapshot: "head",
  revision,
  scope: [{ glob: "requirements/repo-guard/*.yaml", format: "yaml" }],
  sources,
});

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean).sort();

const requiresRelations = graph.relations.filter((relation) => relation.relation === "requires");
const requires = [...new Set(requiresRelations.map((relation) => relation.object))].sort();

assert.deepEqual(requires, tracked, "every exact tracked artifact must have requires provenance");
assert.ok(requiresRelations.length >= tracked.length, "every tracked artifact must have at least one requires relation");

const forward = new Map();
const reverse = new Map();
for (const relation of graph.relations) {
  const byRequirement = forward.get(relation.subject) || [];
  byRequirement.push(relation);
  forward.set(relation.subject, byRequirement);
  const byArtifact = reverse.get(relation.object) || [];
  byArtifact.push(relation);
  reverse.set(relation.object, byArtifact);
}

assert.deepEqual([...forward.keys()].sort(), expectedIds);
assert.equal(reverse.size, tracked.length);
for (const path of tracked) {
  const relations = reverse.get(path) || [];
  assert.ok(relations.some((relation) => relation.relation === "requires"), `${path}: at least one requires relation is mandatory`);
  for (const relation of relations) {
    assert.equal(typeof relation.provenance.source_path, "string");
    assert.equal(relation.provenance.snapshot, "head");
    assert.equal(relation.provenance.revision, revision);
  }
}
for (const path of tracked.filter((path) => path.startsWith("src/") || path.startsWith("dist/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "implements"), `${path}: code artifact must implement`);
}
for (const path of tracked.filter((path) => path.startsWith("tests/"))) {
  assert.ok((reverse.get(path) || []).some((relation) => relation.relation === "verifies"), `${path}: test artifact must verify`);
}

const documentationLanguageRelations = reverse.get("tests/test-documentation-language.mjs") || [];
const documentationLanguageRequires = new Set(
  documentationLanguageRelations.filter((relation) => relation.relation === "requires").map((relation) => relation.subject),
);
const documentationLanguageVerifies = new Set(
  documentationLanguageRelations.filter((relation) => relation.relation === "verifies").map((relation) => relation.subject),
);
for (const requirement of ["RG-04", "RG-06"]) {
  assert.ok(documentationLanguageRequires.has(requirement), `documentation-language must expose requires(${requirement}, artifact)`);
  assert.ok(documentationLanguageVerifies.has(requirement), `documentation-language must expose verifies(${requirement}, artifact)`);
}

const reviewedDirectImportCrossLinks = [
  ["RG-04", "tests/test-644-a-requirement-relation-core.mjs"],
  ["RG-04", "tests/test-c3-3d2-change-profile-lowering.mjs"],
  ["RG-04", "tests/test-p0-5-trusted-diff-budget-ceilings.mjs"],
  ["RG-04", "tests/test-p1-1-policy-normalization.mjs"],
  ["RG-05", "tests/test-c3-9g-doctor-git-evidence.mjs"],
  ["RG-07", "tests/test-projection-freshness-red.mjs"],
];
for (const [requirement, path] of reviewedDirectImportCrossLinks) {
  const relations = reverse.get(path) || [];
  assert.ok(relations.some((relation) => relation.subject === requirement && relation.relation === "requires"), `${path}: requires(${requirement}, artifact) must be visible`);
  assert.ok(relations.some((relation) => relation.subject === requirement && relation.relation === "verifies"), `${path}: verifies(${requirement}, artifact) must be visible`);
}

const reviewedTransitiveCliCrossLinks = [
  ["RG-04", "tests/test-c3-10a-external-base-cutover.mjs"],
  ["RG-04", "tests/test-check-diff-boundary.mjs"],
  ["RG-04", "tests/test-p2-2-lazy-trust-lookup.mjs"],
];
for (const [requirement, path] of reviewedTransitiveCliCrossLinks) {
  const relations = reverse.get(path) || [];
  assert.ok(relations.some((relation) => relation.subject === requirement && relation.relation === "requires"), `${path}: requires(${requirement}, artifact) must be visible`);
  assert.ok(relations.some((relation) => relation.subject === requirement && relation.relation === "verifies"), `${path}: verifies(${requirement}, artifact) must be visible`);
}

console.log(`#645 self-host relation inventory: ${tracked.length}/${tracked.length} tracked artifacts, complete reverse requires provenance, graph=${graph.graph_sha256}, revision=${revision}`);


// #662 PRE-POLICY differential witness.
// This remains test-local: production cochange authority is unchanged until
// relation-derived transaction evidence proves equivalent or stricter behavior.
const fixtureRevision = "a".repeat(40);
function fixtureGraph(snapshot, declarations) {
  const grouped = new Map();
  for (const declaration of declarations) {
    const artifacts = grouped.get(declaration.subject) || [];
    artifacts.push(declaration);
    grouped.set(declaration.subject, artifacts);
  }
  const fixtureSources = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, artifacts]) => ({
    path: `requirements/${subject}.yaml`,
    format: "yaml",
    content: [
      `id: ${subject}`,
      "artifacts:",
      ...artifacts.flatMap(({ path, relations }) => [
        `  - path: ${JSON.stringify(path)}`,
        `    relations: [${relations.join(", ")}]`,
      ]),
      "",
    ].join("\n"),
  }));
  return normalizeRequirementAuthority({
    snapshot,
    revision: fixtureRevision,
    scope: [{ glob: "requirements/*.yaml", format: "yaml" }],
    sources: fixtureSources,
  });
}

function broadCochange(changedPaths) {
  const sourceChanged = changedPaths.some((path) => path.startsWith("src/"));
  const testChanged = changedPaths.some((path) => path.startsWith("tests/"));
  return !sourceChanged || testChanged;
}

function relationOverlapEvidence({ baseGraph, headGraph, changedPaths }) {
  const changed = new Set(changedPaths);
  const implementationRequirements = new Set(
    [...baseGraph.relations, ...headGraph.relations]
      .filter((relation) => relation.relation === "implements"
        && relation.object.startsWith("src/")
        && changed.has(relation.object))
      .map((relation) => relation.subject),
  );
  if (!implementationRequirements.size) return { ok: true, overlap: [] };

  const verificationRequirements = new Set(
    headGraph.relations
      .filter((relation) => relation.relation === "verifies"
        && relation.object.startsWith("tests/")
        && changed.has(relation.object))
      .map((relation) => relation.subject),
  );
  const overlap = [...implementationRequirements].filter((subject) => verificationRequirements.has(subject)).sort();
  return { ok: overlap.length > 0, overlap };
}

const related = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: related,
  headGraph: related,
  changedPaths: ["src/a.mts", "tests/a.mjs"],
}).ok, true, "#662 related implementation + verification must pass");

const unrelated = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-B", path: "tests/b.mjs", relations: ["requires", "verifies"] },
]);
const unrelatedPaths = ["src/a.mts", "tests/b.mjs"];
assert.equal(broadCochange(unrelatedPaths), true, "#662 legacy broad cochange accepts any changed test");
assert.equal(relationOverlapEvidence({
  baseGraph: unrelated,
  headGraph: unrelated,
  changedPaths: unrelatedPaths,
}).ok, false, "#662 relation overlap must reject an unrelated changed test");

const crossCutting = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-B", path: "src/b.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/cross.mjs", relations: ["requires", "verifies"] },
  { subject: "RG-B", path: "tests/cross.mjs", relations: ["requires", "verifies"] },
]);
const crossVerdict = relationOverlapEvidence({
  baseGraph: crossCutting,
  headGraph: crossCutting,
  changedPaths: ["src/a.mts", "src/b.mts", "tests/cross.mjs"],
});
assert.equal(crossVerdict.ok, true, "#662 explicit many-to-many verification must pass");
assert.deepEqual(crossVerdict.overlap, ["RG-A", "RG-B"]);

const baseDeleted = fixtureGraph("base", [
  { subject: "RG-A", path: "src/old.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
const headDeleted = fixtureGraph("head", [
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: baseDeleted,
  headGraph: headDeleted,
  changedPaths: ["src/old.mts", "tests/a.mjs"],
}).ok, true, "#662 deleted BASE-only implementation must retain requirement identity");

const generatedOnly = fixtureGraph("head", [
  { subject: "RG-A", path: "dist/a.mjs", relations: ["requires", "implements"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: generatedOnly,
  headGraph: generatedOnly,
  changedPaths: ["dist/a.mjs"],
}).ok, true, "#662 generated dist must not duplicate src transaction evidence");

const transitionBase = fixtureGraph("base", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
]);
const transitionHead = fixtureGraph("head", [
  { subject: "RG-A", path: "src/a.mts", relations: ["requires", "implements"] },
  { subject: "RG-A", path: "tests/a.mjs", relations: ["requires", "verifies"] },
]);
assert.equal(relationOverlapEvidence({
  baseGraph: transitionBase,
  headGraph: transitionHead,
  changedPaths: ["src/a.mts", "tests/a.mjs"],
}).ok, true, "#662 candidate evidence can observe proposed relations");
const unauthorizedTransition = checkRequirementTransition({
  base: transitionBase,
  head: transitionHead,
  grant: null,
  trustedAuthorizer: null,
});
assert.equal(unauthorizedTransition.required, true);
assert.equal(unauthorizedTransition.authorized, false);
assert.equal(unauthorizedTransition.ok, false, "#662 evidence must not self-authorize its relation transition");

console.log("#662 relation-overlap transaction falsifier passed");


console.log("\n--- #723 I8 GREEN: real vNext self-host SH01-SH40 ---");
{
  const pipeline = await import("../dist/runtime/pipeline.mjs");
  const gitRuntime = await import("../dist/git.mjs");
  const canonicalRuntime = await import("../dist/runtime/canonical-requirements.mjs");
  const requirementRuntime = await import("../dist/runtime/requirement-closure.mjs");
  const resolverRuntime = await import("../dist/runtime/resource-resolver.mjs");
  const resourceRuntime = await import("../dist/runtime/resource-closure.mjs");
  const transitionRuntime = await import("../dist/runtime/transition-closure.mjs");

  const repository = "netkeep80/repo-guard";
  const gitText = (cwd, args, options = {}) => execFileSync("git", args, { cwd, encoding: "utf8", ...options }).trim();
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : null;
  const headRevision = event?.pull_request?.head?.sha || gitText(root, ["rev-parse", "HEAD"]);
  let trustedAuthorityBaseRevision;
  if (event?.pull_request) trustedAuthorityBaseRevision = gitText(root, ["rev-parse", "refs/remotes/origin/main"]);
  else {
    try { trustedAuthorityBaseRevision = gitText(root, ["rev-parse", headRevision + "^1"]); }
    catch { trustedAuthorityBaseRevision = headRevision; }
  }
  const baseRevision = gitText(root, ["merge-base", trustedAuthorityBaseRevision, headRevision]);
  for (const sha of [trustedAuthorityBaseRevision, baseRevision, headRevision]) assert.match(sha, /^[0-9a-f]{40}$/);

  const exactTracked = gitRuntime.listTrackedFilesAtRef(headRevision, root).sort();
  const exactDiff = gitRuntime.getExactDiffIdentity(baseRevision, headRevision, root);
  const diffText = gitRuntime.runGit(["-c", "core.quotepath=false", "diff", baseRevision, headRevision], { cwd: root });
  const basePolicy = JSON.parse(gitRuntime.readFileAtRef(baseRevision, "repo-policy.json", root));
  const headPolicy = JSON.parse(gitRuntime.readFileAtRef(headRevision, "repo-policy.json", root));
  const policyInput = {
    mode: "check-diff",
    repositoryRoot: root,
    repositoryIdentity: repository,
    policy: headPolicy,
    basePolicy,
    headPolicy,
    baseRef: baseRevision,
    headRef: headRevision,
    enforcement: { ok: true, mode: "blocking", source: "i8-self-host-test", requested: "blocking" },
    diffText,
    diffFiles: exactDiff,
    trackedFiles: exactTracked,
    changeIntent: null,
    changeIntentSource: "github_issue:#723",
    readFile: (filePath) => gitRuntime.readFileAtRef(headRevision, filePath, root),
    readFileAtRef: (sha, filePath) => gitRuntime.readFileAtRef(sha, filePath, root),
  };
  const protectedBoundary = ["docs/product-requirements.md", ".github/workflows/trusted-enforcement.yml"];
  const config = {
    repository,
    repositoryRoot: root,
    trustedAuthorityBaseRevision,
    baseRevision,
    headRevision,
    workIntent: { id: "github:issue:723", source: "github_issue", addresses: ["RG-04", "RG-05"] },
    protectedResources: protectedBoundary,
  };
  const shadow = pipeline.runRepoGuardSelfHostShadow(policyInput, { quiet: true }, config);
  assert.equal(shadow.selfHost.ok, true, shadow.selfHost.reasons.join(" | "));
  assert.equal(shadow.legacy.ok, true, JSON.stringify(shadow.legacy));
  assert.equal(shadow.comparison.classification, "EQUIVALENT");

  const passed = [];
  const sh = (number, fn) => {
    fn();
    const id = "SH" + String(number).padStart(2, "0");
    passed.push(id);
    console.log("PASS: #723 " + id);
  };
  const reasonHas = (result, fragment) => result.reasons.some((reason) => reason.includes(fragment));
  const actualInput = { ...config, observedTrackedPaths: exactTracked, observedDiffFiles: exactDiff };

  sh(1, () => assert.deepEqual(shadow.selfHost.authority.rootIds, expectedIds));
  sh(2, () => {
    assert.equal(shadow.selfHost.projection.semanticDigestMatchesValue, true);
    assert.equal(shadow.selfHost.projection.normativeAuthoritySeparated, true);
  });
  sh(3, () => assert.deepEqual(shadow.selfHost.head.rooted, expectedIds));
  sh(4, () => {
    assert.equal(shadow.selfHost.authority.revision, trustedAuthorityBaseRevision);
    if (event?.pull_request) assert.notEqual(shadow.selfHost.authority.revision, headRevision);
  });
  sh(5, () => {
    assert.equal(shadow.selfHost.observation.trackedComplete, true);
    assert.equal(shadow.selfHost.observation.exactTrackedCount, exactTracked.length);
  });
  sh(6, () => {
    assert.equal(shadow.selfHost.head.justified, exactTracked.length);
    assert.deepEqual(shadow.selfHost.head.unjustified, []);
  });

  const rawHead = canonicalRuntime.loadCanonicalRequirements({
    repository, revision: headRevision, paths: requirementPaths,
    readFile: (sha, filePath) => gitRuntime.readFileAtRef(sha, filePath, root),
  });
  const projectedHead = pipeline.projectRepoGuardLegacyRequirements(rawHead);
  sh(7, () => {
    for (const item of projectedHead.requirements.requirements) {
      const selfRequires = Object.values(item.value.relations || {}).filter((relation) =>
        relation?.predicate === "requires" && relation?.target?.kind === "artifact" && relation.target.path === item.source.path);
      assert.deepEqual(selfRequires, [], item.id + ": canonical source must use implicit J2 justification, not self-requires");
    }

    const renameClone = mkdtempSync(join(tmpdir(), "repo-guard-i8-source-rename-"));
    try {
      execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", root, renameClone], { encoding: "utf8" });
      gitText(renameClone, ["config", "user.email", "i8@example.invalid"]);
      gitText(renameClone, ["config", "user.name", "I8"]);
      gitText(renameClone, ["checkout", "-q", trustedAuthorityBaseRevision]);
      const oldPath = "requirements/repo-guard/RG-08.yaml";
      const newPath = "requirements/repo-guard/RG-08-renamed.yaml";
      gitText(renameClone, ["mv", oldPath, newPath]);
      gitText(renameClone, ["commit", "-q", "-m", "representation-only requirement source rename"]);
      const renameHead = gitText(renameClone, ["rev-parse", "HEAD"]);
      const renameResult = pipeline.evaluateRepoGuardSelfHost({
        repository, repositoryRoot: renameClone,
        trustedAuthorityBaseRevision, baseRevision: trustedAuthorityBaseRevision, headRevision: renameHead,
        observedTrackedPaths: gitRuntime.listTrackedFilesAtRef(renameHead, renameClone),
        observedDiffFiles: gitRuntime.getExactDiffIdentity(trustedAuthorityBaseRevision, renameHead, renameClone),
        workIntent: { id: "source-rename", source: "github_issue", addresses: ["RG-08"] },
      });
      assert.equal(renameResult.ok, true, renameResult.reasons.join(" | "));
      assert.ok(renameResult.transition.deltas.some((delta) => delta.kind === "requirement_relocate" && delta.subject === "RG-08"));
      assert.ok(renameResult.transition.deltas.some((delta) => delta.kind === "resource_rename" && delta.beforePath === oldPath && delta.afterPath === newPath));
      assert.equal(renameResult.head.justified, renameResult.head.tracked);
    } finally {
      rmSync(renameClone, { recursive: true, force: true });
    }
  });
  sh(8, () => {
    const multi = [...reverse.values()].filter((relations) =>
      new Set(relations.filter((relation) => relation.relation === "requires").map((relation) => relation.subject)).size > 1);
    assert.ok(multi.length >= 11);
  });
  sh(9, () => {
    const distPaths = exactTracked.filter((filePath) => filePath.startsWith("dist/"));
    for (const filePath of distPaths) {
      const facts = shadow.selfHost.projection.facts.filter((fact) => fact.path === filePath);
      assert.ok(facts.some((fact) => fact.predicate === "requires"));
      assert.ok(facts.some((fact) => fact.predicate === "implemented_by"));
    }
  });
  sh(10, () => {
    const incomplete = pipeline.evaluateRepoGuardSelfHost({ ...actualInput, observedTrackedPaths: exactTracked.slice(1) });
    assert.equal(incomplete.ok, false);
    assert.ok(reasonHas(incomplete, "tracked_tree_observation_mismatch"));
  });

  const gitFixture = mkdtempSync(join(tmpdir(), "repo-guard-i8-git-"));
  try {
    gitText(gitFixture, ["init", "-q"]);
    gitText(gitFixture, ["config", "user.email", "i8@example.invalid"]);
    gitText(gitFixture, ["config", "user.name", "I8"]);
    for (const pair of [
      ["delete.txt", "delete\n"], ["modify.txt", "before\n"], ["rename-old.txt", "rename\n"],
      ["type.txt", "regular\n"], ["mode.txt", "mode\n"],
    ]) writeFileSync(resolve(gitFixture, pair[0]), pair[1]);
    writeFileSync(resolve(gitFixture, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    gitText(gitFixture, ["add", "-A"]);
    gitText(gitFixture, ["commit", "-q", "-m", "base"]);
    const gitBase = gitText(gitFixture, ["rev-parse", "HEAD"]);
    writeFileSync(resolve(gitFixture, "add.txt"), "add\n");
    writeFileSync(resolve(gitFixture, "modify.txt"), "after\n");
    unlinkSync(resolve(gitFixture, "delete.txt"));
    gitText(gitFixture, ["mv", "rename-old.txt", "rename-new.txt"]);
    writeFileSync(resolve(gitFixture, "binary.bin"), Buffer.from([0, 9, 8, 7]));
    gitText(gitFixture, ["add", "-A"]);
    gitText(gitFixture, ["update-index", "--chmod=+x", "mode.txt"]);
    const linkBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: gitFixture, input: "target", encoding: "utf8" }).trim();
    gitText(gitFixture, ["update-index", "--add", "--cacheinfo", "120000," + linkBlob + ",type.txt"]);
    gitText(gitFixture, ["commit", "-q", "-m", "head"]);
    const gitHead = gitText(gitFixture, ["rev-parse", "HEAD"]);
    const fixtureDiff = gitRuntime.getExactDiffIdentity(gitBase, gitHead, gitFixture);
    const fixtureHeadEntries = gitRuntime.listTrackedEntriesAtRef(gitHead, gitFixture);
    sh(11, () => assert.ok(fixtureDiff.some((file) => file.status === "added" && file.path === "add.txt")));
    sh(12, () => {
      assert.ok(fixtureDiff.some((file) => file.status === "modified" && file.path === "modify.txt"));
      assert.ok(fixtureDiff.some((file) => file.status === "modified" && file.path === "binary.bin"));
    });
    sh(13, () => {
      assert.ok(fixtureDiff.some((file) => file.status === "deleted" && file.path === "delete.txt"));
      assert.ok(fixtureDiff.some((file) => file.previousPath === "rename-old.txt" && file.path === "rename-new.txt"));
    });
    sh(14, () => {
      assert.ok(fixtureDiff.some((file) => file.gitStatus === "T" && file.path === "type.txt"));
      assert.equal(fixtureHeadEntries.find((entry) => entry.path === "mode.txt")?.mode, "100755");
      assert.equal(fixtureHeadEntries.find((entry) => entry.path === "type.txt")?.mode, "120000");
    });
  } finally {
    rmSync(gitFixture, { recursive: true, force: true });
  }

  sh(15, () => {
    assert.ok(shadow.selfHost.transition.deltas.some((delta) => delta.kind.startsWith("resource_")));
    assert.equal(shadow.selfHost.transition.deltas.some((delta) => delta.kind.startsWith("requirement_")), false);
  });
  sh(16, () => {
    for (const explanation of shadow.selfHost.transition.explanations.whyChanged)
      assert.ok(explanation.causes.length > 0, JSON.stringify(explanation));
  });
  sh(17, () => {
    const noCause = pipeline.evaluateRepoGuardSelfHost({ ...actualInput, workIntent: { id: "none", addresses: [] } });
    assert.equal(noCause.ok, false);
    assert.ok(reasonHas(noCause, "J3:no_cause"));
  });
  sh(18, () => {
    assert.equal(unauthorizedTransition.ok, false);
    assert.equal(unauthorizedTransition.authorized, false);
  });

  const repoClone = mkdtempSync(join(tmpdir(), "repo-guard-i8-self-"));
  const resetClone = () => {
    gitText(repoClone, ["reset", "--hard", trustedAuthorityBaseRevision]);
    gitText(repoClone, ["clean", "-fdx"]);
  };
  const commitClone = (message) => {
    gitText(repoClone, ["add", "-A"]);
    gitText(repoClone, ["commit", "-q", "-m", message]);
    return gitText(repoClone, ["rev-parse", "HEAD"]);
  };
  const cloneEval = (base, head, options = {}) => pipeline.evaluateRepoGuardSelfHost({
    repository, repositoryRoot: repoClone,
    trustedAuthorityBaseRevision, baseRevision: base, headRevision: head,
    observedTrackedPaths: gitRuntime.listTrackedFilesAtRef(head, repoClone),
    observedDiffFiles: gitRuntime.getExactDiffIdentity(base, head, repoClone),
    workIntent: { id: "github:issue:723:adversarial", source: "github_issue", addresses: expectedIds },
    protectedResources: protectedBoundary,
    ...options,
  });
  try {
    execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", root, repoClone], { encoding: "utf8" });
    gitText(repoClone, ["config", "user.email", "i8@example.invalid"]);
    gitText(repoClone, ["config", "user.name", "I8"]);
    resetClone();
    writeFileSync(resolve(repoClone, "README.md"), readFileSync(resolve(repoClone, "README.md"), "utf8") + "\nI8 stacked base\n");
    const stackedBase = commitClone("stack base");
    writeFileSync(resolve(repoClone, "README.md"), readFileSync(resolve(repoClone, "README.md"), "utf8") + "I8 stacked head\n");
    const stackedHead = commitClone("stack head");
    const stacked = cloneEval(stackedBase, stackedHead);
    sh(19, () => {
      assert.equal(stacked.ok, true, stacked.reasons.join(" | "));
      assert.equal(stacked.trustBoundary.trustedAuthorityBaseRevision, trustedAuthorityBaseRevision);
      assert.notEqual(stackedBase, trustedAuthorityBaseRevision);
    });

    resetClone();
    const protectedPath = "src/runtime/pipeline.mts";
    writeFileSync(resolve(repoClone, protectedPath), readFileSync(resolve(repoClone, protectedPath), "utf8") + "\n// I8 protected transition fixture\n");
    const protectedHead = commitClone("protected resource transition");
    const staleReceipt = {
      authorityBaseRevision: trustedAuthorityBaseRevision,
      baseRevision: trustedAuthorityBaseRevision,
      headRevision: "f".repeat(40),
      permissions: ["resource:" + protectedPath],
    };
    const stale = cloneEval(trustedAuthorityBaseRevision, protectedHead, {
      protectedResources: [...protectedBoundary, protectedPath],
      trustedReceipts: [staleReceipt],
    });
    const exactReceipt = {
      authorityBaseRevision: trustedAuthorityBaseRevision,
      baseRevision: trustedAuthorityBaseRevision,
      headRevision: protectedHead,
      permissions: ["resource:" + protectedPath],
    };
    const exactAuthorized = cloneEval(trustedAuthorityBaseRevision, protectedHead, {
      protectedResources: [...protectedBoundary, protectedPath],
      trustedReceipts: [exactReceipt],
    });
    sh(20, () => {
      assert.equal(stale.ok, false);
      assert.ok(reasonHas(stale, "missing_authority:resource:" + protectedPath));
      assert.equal(exactAuthorized.ok, true, exactAuthorized.reasons.join(" | "));
    });
    sh(21, () => {
      assert.equal(shadow.selfHost.observation.trackedComplete, true);
      assert.deepEqual(shadow.selfHost.observation.exactDiffIdentity, shadow.selfHost.observation.observedDiffIdentity);
      assert.equal(shadow.selfHost.trustBoundary.trustedAuthorityBaseRevision, trustedAuthorityBaseRevision);
    });

    const makeEvidenceGitFixture = (evidenceSpec) => {
      const dir = mkdtempSync(join(tmpdir(), "repo-guard-i8-evidence-"));
      gitText(dir, ["init", "-q"]);
      gitText(dir, ["config", "user.email", "i8-evidence@example.invalid"]);
      gitText(dir, ["config", "user.name", "I8 Evidence"]);
      mkdirSync(resolve(dir, "requirements"), { recursive: true });
      mkdirSync(resolve(dir, "src"), { recursive: true });
      mkdirSync(resolve(dir, "tests"), { recursive: true });

      const requirementValue = {
        id: "R",
        relations: {
          impl: { predicate: "requires", target: { kind: "artifact", path: "src/x" } },
          verifier: { predicate: "verified_by", target: { kind: "artifact", path: "tests/v.mjs" } },
        },
        constraints: [{ id: "c", relations: ["requires"], metric: "changed_lines", max: 10, evidence: evidenceSpec }],
      };
      writeFileSync(resolve(dir, "requirements/R.json"), JSON.stringify(requirementValue, null, 2) + "\n");
      writeFileSync(resolve(dir, "src/x"), "base\n");
      writeFileSync(resolve(dir, "tests/v.mjs"), [
        'import { readFileSync } from "node:fs";',
        'const value = readFileSync("src/x", "utf8");',
        'if (value !== "head\\n") process.exit(7);',
        'console.log("DOMAIN_OK:" + value.trim());',
        "",
      ].join("\n"));
      gitText(dir, ["add", "-A"]);
      gitText(dir, ["commit", "-q", "-m", "evidence base"]);
      const base = gitText(dir, ["rev-parse", "HEAD"]);

      writeFileSync(resolve(dir, "src/x"), "head\n");
      gitText(dir, ["add", "-A"]);
      gitText(dir, ["commit", "-q", "-m", "evidence head"]);
      const head = gitText(dir, ["rev-parse", "HEAD"]);

      for (const sha of [base, head]) {
        assert.match(sha, /^[0-9a-f]{40}$/);
        assert.doesNotThrow(() => gitText(dir, ["cat-file", "-e", sha + "^{commit}"]));
      }

      const loadRequirements = (sha) => canonicalRuntime.loadCanonicalRequirements({
        repository: "fixture/evidence",
        revision: sha,
        paths: ["requirements/R.json"],
        readFile: (revisionValue, filePath) => gitRuntime.readFileAtRef(revisionValue, filePath, dir),
      });
      const baseRequirements = loadRequirements(base);
      const headRequirements = loadRequirements(head);
      assert.equal(baseRequirements.ok, true, JSON.stringify(baseRequirements.errors));
      assert.equal(headRequirements.ok, true, JSON.stringify(headRequirements.errors));
      assert.equal(baseRequirements.index.R.semantic.digest, headRequirements.index.R.semantic.digest);

      const trustedRoot = baseRequirements.index.R.semantic;
      const makeState = (sha, requirements) => {
        const j2 = requirementRuntime.evaluateRootedRequirements({ requirements, trustedRoots: [trustedRoot] });
        const trackedPaths = gitRuntime.listTrackedFilesAtRef(sha, dir);
        const resolver = resolverRuntime.createResourceResolver({
          repository: "fixture/evidence",
          revision: sha,
          requirements,
          readers: {
            "fixture/evidence": (revisionValue, filePath) => {
              try { return gitRuntime.readFileAtRef(revisionValue, filePath, dir); }
              catch { return null; }
            },
          },
        });
        const j1 = resourceRuntime.evaluateTrackedResourceClosure({
          repository: "fixture/evidence", revision: sha, requirements, j2, trackedPaths, resolver,
        });
        assert.equal(j2.ok, true, JSON.stringify(j2));
        assert.equal(j1.ok, true, JSON.stringify(j1));
        return { revision: sha, requirements, j2, j1 };
      };
      const baseState = makeState(base, baseRequirements);
      const headState = makeState(head, headRequirements);
      const diffFiles = gitRuntime.getExactDiffIdentity(base, head, dir);
      const resourceDeltas = transitionRuntime.resourceDeltasFromParsedDiff(diffFiles);
      assert.deepEqual(resourceDeltas, [{ kind: "modify", path: "src/x" }]);

      const numstat = gitText(dir, ["diff", "--numstat", base + "..." + head, "--", "src/x"]);
      const [addedRaw, deletedRaw, observedPath] = numstat.split(/\s+/);
      assert.equal(observedPath, "src/x");
      const added = Number(addedRaw), deleted = Number(deletedRaw);
      assert.ok(Number.isSafeInteger(added) && Number.isSafeInteger(deleted));
      const changedLines = added + deleted;

      const verifierRun = spawnSync(process.execPath, ["tests/v.mjs"], { cwd: dir, encoding: "utf8" });
      assert.equal(verifierRun.status, 0, String(verifierRun.stdout) + "\n" + String(verifierRun.stderr));
      assert.match(String(verifierRun.stdout), /DOMAIN_OK:head/);

      return {
        dir, base, head, baseState, headState, resourceDeltas, changedLines, verifierRun,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    };

    const domainFixture = makeEvidenceGitFixture({
      kind: "domain", key: "domain:k", providerId: "domain-process",
    });
    const execFixture = makeEvidenceGitFixture({
      kind: "execution", key: "exec:k", providerId: "exec-process", verifierPath: "tests/v.mjs",
    });
    const domainCommon = {
      repository: "fixture/evidence",
      base: domainFixture.baseState,
      head: domainFixture.headState,
      trustedAuthorityBase: {
        revision: domainFixture.base,
        requirements: domainFixture.baseState.requirements,
        j2: domainFixture.baseState.j2,
      },
      resourceDeltas: domainFixture.resourceDeltas,
      workIntent: { id: "evidence", addresses: ["R"] },
      trustedEvidenceProviders: ["git-observation", "domain-process"],
    };
    const exactObservation = {
      authorityBaseRevision: domainFixture.base,
      baseRevision: domainFixture.base,
      headRevision: domainFixture.head,
      path: "src/x",
      metric: "changed_lines",
      value: domainFixture.changedLines,
      providerId: "git-observation",
    };
    const exactDomain = {
      authorityBaseRevision: domainFixture.base,
      baseRevision: domainFixture.base,
      headRevision: domainFixture.head,
      key: "domain:k",
      status: domainFixture.verifierRun.status === 0 ? "pass" : "fail",
      providerId: "domain-process",
      requirementId: "R",
      subjectPaths: ["src/x"],
    };
    try {
      const noObservation = transitionRuntime.evaluateTransitionCauseClosure({
        ...domainCommon, evidenceFacts: [exactDomain],
      });
      sh(22, () => {
        assert.equal(noObservation.ok, false);
        assert.ok(noObservation.reasons.some((reason) => reason.includes("I7:missing_observation")));
      });

      const missingExec = transitionRuntime.evaluateTransitionCauseClosure({
        repository: "fixture/evidence",
        base: execFixture.baseState,
        head: execFixture.headState,
        trustedAuthorityBase: {
          revision: execFixture.base,
          requirements: execFixture.baseState.requirements,
          j2: execFixture.baseState.j2,
        },
        resourceDeltas: execFixture.resourceDeltas,
        workIntent: { id: "exec", addresses: ["R"] },
        trustedEvidenceProviders: ["git-observation", "exec-process"],
        observationFacts: [{
          authorityBaseRevision: execFixture.base,
          baseRevision: execFixture.base,
          headRevision: execFixture.head,
          path: "src/x",
          metric: "changed_lines",
          value: execFixture.changedLines,
          providerId: "git-observation",
        }],
      });
      sh(23, () => {
        assert.equal(execFixture.verifierRun.status, 0, "external verifier fixture itself must be executable");
        assert.equal(missingExec.ok, false);
        assert.ok(missingExec.reasons.some((reason) => reason.includes("I7:missing_evidence")));
      });

      const wrongSubject = transitionRuntime.evaluateTransitionCauseClosure({
        ...domainCommon,
        observationFacts: [exactObservation],
        evidenceFacts: [{ ...exactDomain, subjectPaths: [] }],
      });
      const domainPass = transitionRuntime.evaluateTransitionCauseClosure({
        ...domainCommon,
        observationFacts: [exactObservation],
        evidenceFacts: [exactDomain],
      });
      sh(24, () => {
        assert.equal(wrongSubject.ok, false);
        assert.ok(wrongSubject.reasons.some((reason) => reason.includes("I7:missing_evidence")));
        assert.equal(domainPass.ok, true, domainPass.reasons.join(" | "));
      });
      console.log(JSON.stringify({
        event: "I8_REAL_EVIDENCE",
        domain: {
          base: domainFixture.base,
          head: domainFixture.head,
          resourceDeltas: domainFixture.resourceDeltas,
          observation: { path: "src/x", metric: "changed_lines", value: domainFixture.changedLines, providerId: "git-observation" },
          verifier: { providerId: "domain-process", exitCode: domainFixture.verifierRun.status, stdout: String(domainFixture.verifierRun.stdout).trim() },
          evaluatorVerdict: domainPass.ok,
        },
        executionTraceOnly: {
          base: execFixture.base,
          head: execFixture.head,
          verifierProcessExitCode: execFixture.verifierRun.status,
          evidenceFactSupplied: false,
          evaluatorVerdict: missingExec.ok,
        },
        providerAuthentication: "external to pure evaluator",
      }));
    } finally {
      domainFixture.cleanup();
      execFixture.cleanup();
    }

    sh(25, () => {
      assert.equal(stale.ok, false);
      assert.ok(reasonHas(stale, "missing_authority:resource:" + protectedPath));
    });

    const thrown = pipeline.runPolicyPipelineShadow(policyInput, { quiet: true }, () => { throw new Error("I8 candidate failed"); });
    sh(26, () => {
      assert.deepEqual(thrown.legacy, shadow.legacy);
      assert.match(thrown.comparison.candidate.reasons[0], /^SHADOW_EXECUTION_ERROR:/);
    });
    sh(27, () => {
      assert.equal("vnext" in headPolicy, false);
      assert.equal("shadow" in headPolicy, false);
      assert.ok(shadow.selfHost);
    });
    const opposite = () => ({ ok: !shadow.legacy.ok, reasons: ["I8_DIFFERENTIAL_WITNESS"] });
    const expectedDifference = pipeline.runPolicyPipelineShadow(policyInput, { quiet: true }, opposite, true);
    const unexpectedDifference = pipeline.runPolicyPipelineShadow(policyInput, { quiet: true }, opposite, false);
    sh(28, () => assert.equal(expectedDifference.comparison.classification, "EXPECTED_INTENTIONAL_DIFFERENCE"));
    sh(29, () => assert.equal(unexpectedDifference.comparison.classification, "UNEXPECTED_DIFFERENCE"));
    sh(30, () => assert.deepEqual(pipeline.evaluateRepoGuardSelfHost(actualInput), shadow.selfHost));

    resetClone();
    writeFileSync(resolve(repoClone, "i8-garbage.txt"), "candidate garbage\n");
    writeFileSync(resolve(repoClone, "requirements/repo-guard/RG-08.yaml"),
      readFileSync(resolve(repoClone, "requirements/repo-guard/RG-08.yaml"), "utf8") +
      "\n  - path: \"i8-garbage.txt\"\n    relations: [requires, documents]\n");
    const garbageHead = commitClone("adversarial self justification");
    const garbage = cloneEval(trustedAuthorityBaseRevision, garbageHead);
    sh(31, () => {
      assert.equal(garbage.ok, false);
      assert.ok(reasonHas(garbage, "missing_authority:requirement:RG-08"));
      assert.equal(garbage.head.rooted.includes("RG-08"), true, "relation self-authorization must not masquerade as a normative J2 root change");
    });

    resetClone();
    const productPath = resolve(repoClone, "docs/product-requirements.md");
    writeFileSync(productPath, readFileSync(productPath, "utf8").replace(/^### RG-01 .*$/m, "### RG-01 — candidate may self-approve (adversarial)"));
    const weakenedHead = commitClone("adversarial weaken governing source");
    const weakened = cloneEval(trustedAuthorityBaseRevision, weakenedHead, { protectedResources: [] });
    sh(32, () => {
      assert.equal(weakened.ok, false);
      assert.ok(reasonHas(weakened, "missing_authority:resource:docs/product-requirements.md"));
    });

    resetClone();
    const rg01 = resolve(repoClone, "requirements/repo-guard/RG-01.yaml");
    writeFileSync(rg01, readFileSync(rg01, "utf8").replace(/^id:\s*RG-01$/m, "id: RG-99"));
    const rootSwapHead = commitClone("adversarial root substitution");
    const rootSwap = cloneEval(trustedAuthorityBaseRevision, rootSwapHead);
    sh(33, () => {
      assert.equal(rootSwap.ok, false);
      assert.ok(reasonHas(rootSwap, "head_j2_not_rooted") || reasonHas(rootSwap, "accepted_root"));
    });

    resetClone();
    const trustedWorkflow = resolve(repoClone, ".github/workflows/trusted-enforcement.yml");
    writeFileSync(trustedWorkflow, readFileSync(trustedWorkflow, "utf8") + "\n# adversarial provider substitution\n");
    const providerHead = commitClone("adversarial provider substitution");
    const providerSwap = cloneEval(trustedAuthorityBaseRevision, providerHead, { protectedResources: [] });
    sh(34, () => {
      assert.equal(providerSwap.ok, false);
      assert.ok(reasonHas(providerSwap, "missing_authority:resource:.github/workflows/trusted-enforcement.yml"));
      const wrongProvider = transitionRuntime.evaluateTransitionCauseClosure({
        ...domainCommon, observationFacts: [exactObservation], evidenceFacts: [{ ...exactDomain, providerId: "candidate-provider" }],
      });
      assert.equal(wrongProvider.ok, false);
    });

    resetClone();
    const rg04 = resolve(repoClone, "requirements/repo-guard/RG-04.yaml");
    writeFileSync(rg04, readFileSync(rg04, "utf8").replace(/\n  - path: "[^"]+"\n    relations: \[[^\]]+\]/, ""));
    const relationRemovalHead = commitClone("adversarial remove scope relation");
    const relationRemoval = cloneEval(trustedAuthorityBaseRevision, relationRemovalHead);
    sh(35, () => {
      assert.equal(relationRemoval.ok, false);
      assert.ok(reasonHas(relationRemoval, "missing_authority:requirement:RG-04") || reasonHas(relationRemoval, "head_j1_not_closed"));
      assert.equal(relationRemoval.head.rooted.includes("RG-04"), true, "relation removal must not rewrite normative J2 identity");
    });

    resetClone();
    const historicalPath = "docs/architecture-compression-3-baseline.md";
    unlinkSync(resolve(repoClone, historicalPath));
    const historicalHead = commitClone("adversarial delete historical resource");
    const historical = cloneEval(trustedAuthorityBaseRevision, historicalHead);
    sh(36, () => {
      assert.equal(historical.ok, false);
      assert.ok(reasonHas(historical, "head_j1_not_closed"));
    });

    sh(37, () => {
      const omitted = pipeline.evaluateRepoGuardSelfHost({ ...actualInput, observedDiffFiles: exactDiff.slice(1) });
      assert.equal(omitted.ok, false);
      assert.ok(reasonHas(omitted, "git_diff_observation_mismatch") || reasonHas(omitted, "resource_delta_observation_mismatch"));
    });
    sh(38, () => {
      const missingDomain = transitionRuntime.evaluateTransitionCauseClosure({ ...domainCommon, observationFacts: [exactObservation] });
      assert.equal(missingDomain.ok, false);
      assert.ok(missingDomain.reasons.some((reason) => reason.includes("I7:missing_evidence")));
    });

    resetClone();
    writeFileSync(resolve(repoClone, "dist/git.mjs"), readFileSync(resolve(repoClone, "dist/git.mjs"), "utf8") + "\n// stale I8 dist\n");
    const staleDistHead = commitClone("adversarial stale dist");
    assert.match(staleDistHead, /^[0-9a-f]{40}$/);
    const nodeModules = resolve(repoClone, "node_modules");
    symlinkSync(resolve(root, "node_modules"), nodeModules, process.platform === "win32" ? "junction" : "dir");
    const staleDist = spawnSync(process.execPath, [resolve(repoClone, "scripts/check-dist.mjs")], { cwd: repoClone, encoding: "utf8" });
    sh(39, () => {
      assert.notEqual(staleDist.status, 0);
      assert.match(String(staleDist.stdout) + "\n" + String(staleDist.stderr), /Generated dist is stale/);
    });

    const legacyOnly = pipeline.runPolicyPipeline(policyInput, { quiet: true });
    sh(40, () => {
      assert.deepEqual(legacyOnly, shadow.legacy);
      assert.deepEqual(thrown.legacy, legacyOnly);
    });

    // #723 independent audit falsifiers F-01..F-04.
    // Keep these outside SH01-SH40: they are acceptance regressions discovered
    // by an independent read-only audit after the first 40/40 GREEN claim.
    const auditFailures = [];
    const auditCheck = (id, condition, detail) => {
      if (!condition) auditFailures.push(id + ": " + detail);
    };

    resetClone();
    const auditProductPath = resolve(repoClone, "docs/product-requirements.md");
    const auditProduct = readFileSync(auditProductPath, "utf8");
    const normativeBefore = "**\`MUST\`:** намерение изменения не выдаёт разрешение менять правила управления.";
    assert.ok(auditProduct.includes(normativeBefore), "F-01 fixture must target RG-01 normative body, not its heading");
    writeFileSync(auditProductPath, auditProduct.replace(
      normativeBefore,
      "**\`MUST\`:** намерение изменения не выдаёт разрешение менять правила управления без независимой санкции.",
    ));
    const normativeHead = commitClone("F-01 normative RG-01 body change");
    const normativeUnauthorized = cloneEval(trustedAuthorityBaseRevision, normativeHead, { protectedResources: [] });
    auditCheck(
      "F-01-authoritative-text-binding",
      !normativeUnauthorized.head.rooted.includes("RG-01"),
      "RG-01 remained J2-rooted after normative body changed with unchanged heading",
    );
    const normativeReceipt = {
      authorityBaseRevision: trustedAuthorityBaseRevision,
      baseRevision: trustedAuthorityBaseRevision,
      headRevision: normativeHead,
      permissions: ["requirement:RG-01", "resource:docs/product-requirements.md"],
    };
    const normativeAuthorized = cloneEval(trustedAuthorityBaseRevision, normativeHead, {
      protectedResources: [],
      trustedReceipts: [normativeReceipt],
    });
    auditCheck(
      "F-01-authorized-transition",
      normativeAuthorized.ok,
      "exact independent normative authorization did not produce GREEN: " + normativeAuthorized.reasons.join(" | "),
    );
    auditCheck(
      "F-01-requirement-delta",
      normativeAuthorized.transition.deltas.some((delta) => delta.kind === "requirement_modify" && delta.subject === "RG-01"),
      "normative RG-01 body change was not represented as RequirementDelta",
    );

    resetClone();
    const auditRg01Path = resolve(repoClone, "requirements/repo-guard/RG-01.yaml");
    writeFileSync(auditRg01Path, readFileSync(auditRg01Path, "utf8") +
      "\n  - path: \"README.md\"\n    relations: [documents]\n");
    const descriptiveHead = commitClone("F-02 routine descriptive relation");
    const descriptive = cloneEval(trustedAuthorityBaseRevision, descriptiveHead, { protectedResources: [] });
    auditCheck(
      "F-02-routine-relation-root",
      descriptive.ok,
      "routine descriptive trace update changed normative root identity: " + descriptive.reasons.join(" | "),
    );
    auditCheck(
      "F-02-no-normative-delta",
      !descriptive.transition.deltas.some((delta) => delta.kind === "requirement_modify" && delta.subject === "RG-01"),
      "routine descriptive trace update became RequirementDelta",
    );

    const currentRaw = canonicalRuntime.loadCanonicalRequirements({
      repository,
      revision: headRevision,
      paths: exactTracked,
      readFile: (sha, path) => gitRuntime.readFileAtRef(sha, path, root),
    });
    const currentProjected = pipeline.projectRepoGuardLegacyRequirements(currentRaw);
    if (typeof canonicalRuntime.canonicalSemanticDigest !== "function") {
      auditFailures.push("F-02-digest-invariant: canonicalSemanticDigest is not exported for independent invariant verification");
    } else {
      for (const item of currentProjected.requirements.requirements) {
        auditCheck(
          "F-02-digest-invariant-" + item.id,
          item.semantic.digest === canonicalRuntime.canonicalSemanticDigest(item.value),
          item.id + " semantic.digest != H(projected.value)",
        );
      }
    }

    const diffFixture = mkdtempSync(join(tmpdir(), "repo-guard-i8-diff-contract-"));
    try {
      gitText(diffFixture, ["init", "-q"]);
      gitText(diffFixture, ["config", "user.email", "i8@example.invalid"]);
      gitText(diffFixture, ["config", "user.name", "I8"]);
      writeFileSync(resolve(diffFixture, "a.txt"), "a\n");
      gitText(diffFixture, ["add", "-A"]);
      gitText(diffFixture, ["commit", "-q", "-m", "common"]);
      const common = gitText(diffFixture, ["rev-parse", "HEAD"]);

      gitText(diffFixture, ["checkout", "-q", "-b", "head", common]);
      writeFileSync(resolve(diffFixture, "b.txt"), "b\n");
      gitText(diffFixture, ["add", "-A"]);
      gitText(diffFixture, ["commit", "-q", "-m", "head"]);
      const divergentHead = gitText(diffFixture, ["rev-parse", "HEAD"]);

      gitText(diffFixture, ["checkout", "-q", "-b", "base", common]);
      writeFileSync(resolve(diffFixture, "c.txt"), "c\n");
      gitText(diffFixture, ["add", "-A"]);
      gitText(diffFixture, ["commit", "-q", "-m", "base"]);
      const divergentBase = gitText(diffFixture, ["rev-parse", "HEAD"]);

      const legacyDiverged = gitRuntime.getDiffObservation(divergentBase, divergentHead, diffFixture).files;
      const exactDiverged = gitRuntime.getExactDiffIdentity(divergentBase, divergentHead, diffFixture);
      const identity = (files) => files.map((file) =>
        JSON.stringify([file.status, file.gitStatus || "", file.previousPath || "", file.path])).sort();
      auditCheck(
        "F-03-diverged-base-contract",
        JSON.stringify(identity(legacyDiverged)) === JSON.stringify(identity(exactDiverged)),
        "shared v3 BASE...HEAD identity differs from I8 exact identity",
      );

      const fastForward = gitRuntime.getExactDiffIdentity(common, divergentHead, diffFixture);
      const fastForwardLegacy = gitRuntime.getDiffObservation(common, divergentHead, diffFixture).files;
      auditCheck(
        "F-03-fast-forward",
        JSON.stringify(identity(fastForwardLegacy)) === JSON.stringify(identity(fastForward)),
        "fast-forward diff contracts disagree",
      );

      gitText(diffFixture, ["checkout", "-q", "-B", "rename", common]);
      gitText(diffFixture, ["mv", "a.txt", "renamed.txt"]);
      gitText(diffFixture, ["commit", "-q", "-am", "rename"]);
      const renameHead = gitText(diffFixture, ["rev-parse", "HEAD"]);
      const renameLegacy = gitRuntime.getDiffObservation(common, renameHead, diffFixture).files;
      const renameExact = gitRuntime.getExactDiffIdentity(common, renameHead, diffFixture);
      auditCheck(
        "F-03-rename",
        JSON.stringify(identity(renameLegacy)) === JSON.stringify(identity(renameExact)),
        "rename diff contracts disagree",
      );
    } finally {
      rmSync(diffFixture, { recursive: true, force: true });
    }

    let resilientShadow = null;
    let resilientError = null;
    try {
      resilientShadow = pipeline.runRepoGuardSelfHostShadow(
        policyInput,
        { quiet: true },
        { ...config, trustedAuthorityBaseRevision: "0".repeat(40) },
      );
    } catch (error) {
      resilientError = error;
    }
    auditCheck(
      "F-04-wrapper-does-not-throw",
      resilientError === null,
      resilientError ? String(resilientError.message || resilientError) : "unexpected throw",
    );
    if (resilientShadow) {
      auditCheck(
        "F-04-legacy-preserved",
        JSON.stringify(resilientShadow.legacy) === JSON.stringify(legacyOnly),
        "candidate exception path lost or changed completed legacy verdict",
      );
      auditCheck(
        "F-04-candidate-red",
        resilientShadow.comparison.candidate.ok === false &&
          resilientShadow.comparison.candidate.reasons.some((reason) => reason.startsWith("SHADOW_EXECUTION_ERROR:")),
        "candidate exception was not represented as explicit shadow RED",
      );
    }

    assert.deepEqual(auditFailures, [], "#723 independent audit regressions must be GREEN");
  } finally {
    rmSync(repoClone, { recursive: true, force: true });
  }

  assert.deepEqual(passed, Array.from({ length: 40 }, (_value, index) => "SH" + String(index + 1).padStart(2, "0")));
  console.log(JSON.stringify({
    event: "I8_REAL_SELF_HOST",
    authority: trustedAuthorityBaseRevision,
    base: baseRevision,
    head: headRevision,
    tracked: shadow.selfHost.head.tracked,
    justified: shadow.selfHost.head.justified,
    rooted: shadow.selfHost.head.rooted.length,
    deltas: shadow.selfHost.transition.deltas.length,
    differential: shadow.comparison.classification,
    scenarios: passed.length,
    trustProviderAuthentication: shadow.selfHost.trustBoundary.providerAuthentication,
    trustedRoots: shadow.selfHost.authority.trustedRoots,
    transitionDeltas: shadow.selfHost.transition.deltas,
    transitionExplanations: shadow.selfHost.transition.explanations,
  }));
}
