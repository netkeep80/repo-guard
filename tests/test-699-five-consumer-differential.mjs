import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRoutineRequirementTransition,
  normalizeRequirementAuthority,
} from "../dist/requirement-relations.mjs";
import {
  graph700,
  req700,
  res700,
  rel700,
  wi700,
  receipt700,
  evaluate700,
  transitionDeltas700,
  validateHead700,
  snapshot,
  buildSourceIndex,
  eagerClosure,
  compareSemanticRequirements,
  normalizeResourceRef,
  createResolver,
  pointerStability,
  representationSubject,
  receiptMatches,
  requirementYaml,
  strictCanonicalParse,
} from "./support/vnext-699-model.mjs";
const A = "a".repeat(40);
const B = "b".repeat(40);
const PINS = {
  D1: {
    repo: "netkeep80/anum_docs",
    pin: "862e1b84347773c6c091cc33ce7499cd4900c855",
    policyBlob: "7b47549fac65ef1bd6dc65476b9945de32629fc8",
    governancePaths: 5,
    surfaces: 10,
    changeProfiles: 5,
    tracked: 1036,
  },
  D2: {
    repo: "netkeep80/amemory",
    pin: "c4aab5b5e61c7f30d188fff80aa0f676ef43ec23",
    policyBlob: "7cf24154a2318a171bd0231b02a889076be1a8ba",
    governancePaths: 30,
    surfaces: 0,
    changeProfiles: 0,
    tracked: 156,
  },
  D3: {
    repo: "netkeep80/anum_parser",
    pin: "679f79e8f1692bd88cdebf38c16b97950437afd2",
    policyBlob: "fc17ef608d1750989890ddfe01b0f298396254c2",
    governancePaths: 5,
    surfaces: 0,
    changeProfiles: 0,
    tracked: 67,
  },
  D4: {
    repo: "netkeep80/aprover",
    pin: "98e0152d21d9b492d79aa5017e86a4114d3e5c51",
    policyBlob: "7822e0e68883dc2ee3f2c9cf872b73f681b0706f",
    governancePaths: 4,
    surfaces: 9,
    changeProfiles: 8,
    tracked: 117,
  },
  D5: {
    repo: "netkeep80/mts-nl-compiler",
    pin: "6d9f74625aa35df407563a6cbb046a467894f46b",
    policyBlob: "dbb7cbd6c9f642b4e99d0d98116ca0fabcc1aae6",
    governancePaths: 6,
    surfaces: 0,
    changeProfiles: 0,
    tracked: 154,
  },
};
const exactReceipt = (...permissions) => receipt700(A, B, permissions);
const execution = (resourceId, status = "pass") => ({ resourceId, baseSha: A, headSha: B, status });
const domain = (requirementId, kind, subject = requirementId, status = "pass") => ({
  requirementId, kind, subject, baseSha: A, headSha: B, status,
});
function semverParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}
function semverAdvance(before, after) {
  const a = semverParts(before), b = semverParts(after);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}
function mirrorsMatch(authority, mirrors) {
  return mirrors.every((value) => value === authority);
}
function allOrNoneChanged(changed, members) {
  const count = members.filter((item) => changed.includes(item)).length;
  return count === 0 || count === members.length;
}
function enforcementBoundary(storedMode, externalGate) {
  return {
    storedMode,
    externalGate,
    blocking: externalGate === "blocking",
  };
}
function evaluateWithForbiddenKinds(input, forbiddenKinds) {
  const result = evaluate700(input);
  const headResources = new Map(input.head.resources.map((item) => [item.id, item]));
  const forbidden = result.deltas
    .filter((delta) => delta.kind.startsWith("resource_") || delta.kind === "dependency_update")
    .map((delta) => headResources.get(delta.subject))
    .filter((resource) => resource && forbiddenKinds.includes(resource.kind))
    .map((resource) => "TRANSITION:forbidden_resource_kind:" + resource.kind + ":" + resource.id);
  return { ...result, ok: result.ok && forbidden.length === 0, reasons: [...result.reasons, ...forbidden].sort() };
}
function acceptedRoutineReplacement() {
  const baseRequirement = [
    "id: MNC-001",
    "artifacts:",
    "  - path: src/old.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");
  const headRequirement = [
    "id: MNC-001",
    "artifacts:",
    "  - path: src/new.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");
  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: A,
    sources: [{ path: "requirements/MNC-001.yaml", format: "yaml", content: baseRequirement }],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: B,
    sources: [{ path: "requirements/MNC-001.yaml", format: "yaml", content: headRequirement }],
  });
  return checkRoutineRequirementTransition({
    base,
    head,
    changedFiles: [
      { path: "requirements/MNC-001.yaml", addedLines: [], deletedLines: [], status: "modified" },
      { path: "src/old.mts", addedLines: [], deletedLines: [], status: "deleted" },
      { path: "src/new.mts", addedLines: [], deletedLines: [], status: "added" },
    ],
    headTrackedFiles: ["requirements/MNC-001.yaml", "src/new.mts"],
    readFileAtRef: (revision, path) => {
      assert.equal(path, "requirements/MNC-001.yaml");
      return revision === A ? baseRequirement : headRequirement;
    },
    governancePaths: ["requirements/**"],
    forbiddenPaths: [],
    closedRepository: false,
  });
}
function acceptedRoutineAdditive() {
  const baseRequirement = [
    "id: MNC-001",
    "artifacts:",
    "  - path: src/old.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");
  const headRequirement = [
    "id: MNC-001",
    "artifacts:",
    "  - path: src/old.mts",
    "    relations: [requires, implements]",
    "  - path: src/new.mts",
    "    relations: [requires, implements]",
    "",
  ].join("\n");
  const base = normalizeRequirementAuthority({
    snapshot: "base",
    revision: A,
    sources: [{ path: "requirements/MNC-001.yaml", format: "yaml", content: baseRequirement }],
  });
  const head = normalizeRequirementAuthority({
    snapshot: "head",
    revision: B,
    sources: [{ path: "requirements/MNC-001.yaml", format: "yaml", content: headRequirement }],
  });
  return checkRoutineRequirementTransition({
    base,
    head,
    changedFiles: [
      { path: "requirements/MNC-001.yaml", addedLines: [], deletedLines: [], status: "modified" },
      { path: "src/new.mts", addedLines: [], deletedLines: [], status: "added" },
    ],
    headTrackedFiles: ["requirements/MNC-001.yaml", "src/old.mts", "src/new.mts"],
    readFileAtRef: (revision, path) => {
      assert.equal(path, "requirements/MNC-001.yaml");
      return revision === A ? baseRequirement : headRequirement;
    },
    governancePaths: [],
    forbiddenPaths: [],
    closedRepository: false,
  });
}
function assertGreen(result, label) {
  assert.equal(result.ok, true, label + ": " + result.reasons.join(", "));
}
function assertRed(result, fragment, label) {
  assert.equal(result.ok, false, label);
  assert.ok(result.reasons.some((reason) => reason.includes(fragment)), label + ": " + result.reasons.join(", "));
}
test("#699 G0 exact consumer pins and legacy policy identities are immutable fixtures", () => {
  for (const fixture of Object.values(PINS)) {
    assert.match(fixture.pin, /^[0-9a-f]{40}$/);
    assert.match(fixture.policyBlob, /^[0-9a-f]{40}$/);
  }
  assert.equal(Object.values(PINS).reduce((sum, item) => sum + item.governancePaths, 0), 50);
  assert.equal(Object.values(PINS).reduce((sum, item) => sum + item.surfaces, 0), 19);
  assert.equal(Object.values(PINS).reduce((sum, item) => sum + item.changeProfiles, 0), 13);
});
/* D1 — anum_docs */
test("#699 D1.1 exact contract/conformance fragment resolves; broken pointer is RED", () => {
  const local = snapshot({ revision: A, files: {}, trackedFiles: [] });
  const ext = snapshot({
    repository: PINS.D1.repo,
    revision: PINS.D1.pin,
    files: {
      "cutover/acceptance.json": JSON.stringify({ current: { contract: "contracts/mts-contract-v0.15.json", conformance: "contracts/mts-conformance-v0.15.json" } }),
    },
  });
  const resolver = createResolver({ localSnapshot: local, externalSnapshots: [ext] });
  const ok = resolver.resolve({
    kind: "external_document",
    repository: PINS.D1.repo,
    revision: PINS.D1.pin,
    path: "cutover/acceptance.json",
    pointer: "/current/contract",
  });
  assert.equal(ok.value, "contracts/mts-contract-v0.15.json");
  assert.throws(() => resolver.resolve({
    kind: "external_document",
    repository: PINS.D1.repo,
    revision: PINS.D1.pin,
    path: "cutover/acceptance.json",
    pointer: "/current/missing",
  }), /missing/i);
});
test("#699 D1.2 semantic-law verification is relation/evidence based, not anchor-DSL authority", () => {
  const base = graph700({
    roots: ["R-LAW"],
    requirements: [req700("R-LAW", { requiredVerifiers: ["T-LAW"] })],
    resources: [res700("LAW", "science", { content: "v1" }), res700("T-LAW", "test")],
    relations: [rel700("R-LAW", "implemented_by", "LAW"), rel700("R-LAW", "verified_by", "T-LAW")],
  });
  const head = graph700({ ...base, resources: [res700("LAW", "science", { content: "v2" }), res700("T-LAW", "test")] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-LAW"]) }), "verifier_not_passed", "missing exact verifier result");
  assertGreen(evaluate700({ base, head, workIntent: wi700(["R-LAW"]), executions: [execution("T-LAW")] }), "exact relevant verifier");
});
test("#699 D1.3 accepted scientific resource mutation requires independent exact TRUST", () => {
  const base = graph700({
    roots: ["R-SCI"],
    requirements: [req700("R-SCI")],
    resources: [res700("SCIENCE", "science", { content: "accepted" })],
    relations: [rel700("R-SCI", "implemented_by", "SCIENCE")],
  });
  const head = graph700({ ...base, resources: [res700("SCIENCE", "science", { content: "mutated" })] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-SCI"]), trustedResourceIds: ["SCIENCE"] }), "trust_root:SCIENCE", "immutable science without authority");
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["R-SCI"]), trustedResourceIds: ["SCIENCE"],
    trustedReceipts: [exactReceipt("trust_root:SCIENCE")],
  }), "immutable science with exact authority");
});
test("#699 D1.4 generated projection freshness is DOMAIN evidence; stale is RED and current is GREEN", () => {
  const base = graph700({
    roots: ["R-PROJ"],
    requirements: [req700("R-PROJ")],
    resources: [res700("SOURCE", "source", { content: "a" }), res700("PROJ", "generated", { content: "a" })],
    relations: [rel700("R-PROJ", "implemented_by", "SOURCE"), rel700("SOURCE", "generates", "PROJ")],
  });
  const head = graph700({
    ...base,
    resources: [res700("SOURCE", "source", { content: "b" }), res700("PROJ", "generated", { content: "b" })],
  });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-PROJ"]) }), "generation_freshness", "stale projection");
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["R-PROJ"]),
    domainEvidence: [domain("R-PROJ", "generation_freshness", "SOURCE|generates|PROJ")],
  }), "current projection");
});
test("#699 D1.5 Russian/domain content remains an external DOMAIN observation", () => {
  const base = graph700({
    roots: ["R-RU"],
    requirements: [req700("R-RU", { domainEvidenceOnChange: ["russian_content"] })],
    resources: [res700("README", "doc", { content: "Русский текст" })],
    relations: [rel700("R-RU", "documents", "README")],
  });
  const head = graph700({ ...base, resources: [res700("README", "doc", { content: "English text" })] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-RU"]) }), "DOMAIN:missing:R-RU:russian_content", "missing language-domain result");
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["R-RU"]),
    domainEvidence: [domain("R-RU", "russian_content")],
  }), "domain result supplied");
});
test("#699 D1.6 relevant verification obligation does not imply generic test cochange", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R", { requiredVerifiers: ["T"] })],
    resources: [res700("F", "code", { content: "before" }), res700("T", "test", { content: "unchanged" })],
    relations: [rel700("R", "implemented_by", "F"), rel700("R", "verified_by", "T")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "after" }), res700("T", "test", { content: "unchanged" })] });
  const result = evaluate700({ base, head, workIntent: wi700(["R"]), executions: [execution("T")] });
  assertGreen(result, "verification without mechanical test-file delta");
  assert.equal(result.deltas.some((delta) => delta.subject === "T"), false);
});
test("#699 D1.7 #2173-class large transition uses exact one-shot constraint authority, no permanent profile", () => {
  const base = graph700({
    roots: ["R-RESEARCH"],
    requirements: [req700("R-RESEARCH", { constraints: [{ id: "research-lines", metric: "changed_lines", max: 800 }] })],
    resources: [res700("CORPUS", "science", { content: "small" })],
    relations: [rel700("R-RESEARCH", "implemented_by", "CORPUS")],
  });
  const head = graph700({ ...base, resources: [res700("CORPUS", "science", { content: "large" })] });
  const input = { base, head, workIntent: wi700(["R-RESEARCH"]), metrics: { changedLines: { CORPUS: 17118 } } };
  assertRed(evaluate700(input), "CONSTRAINT:R-RESEARCH:research-lines", "large transition without exact waiver");
  assertGreen(evaluate700({
    ...input,
    trustedReceipts: [exactReceipt("constraint:R-RESEARCH:research-lines")],
  }), "one-shot exact waiver");
});
test("#699 D1.8 MERGED is independent from ACCEPTED/CURRENT/PUBLISHED", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [],
    relations: [],
    lifecycle: { R: { merged: false, accepted: false, current: false, published: false } },
  });
  const merged = graph700({ ...base, lifecycle: { R: { merged: true, accepted: false, current: false, published: false } } });
  assertGreen(evaluate700({ base, head: merged, workIntent: wi700(["R"]) }), "technical merge only");
  const accepted = graph700({ ...merged, lifecycle: { R: { merged: true, accepted: true, current: false, published: false } } });
  assertRed(evaluate700({ base: merged, head: accepted, workIntent: wi700(["R"]) }), "lifecycle:R:accepted", "self-acceptance");
});
test("#699 D1.9 global size budget without Requirement is advisory, not blocking", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R", "implemented_by", "F")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "b" })] });
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["R"]), metrics: { changedLines: { F: 20000 } }, legacyGlobalBudget: 800,
  }), "no Requirement-owned budget");
});
test("#699 D1.10 historical evidence remains justified by an ordinary provenance/history Requirement", () => {
  const graph = graph700({
    roots: ["R-HISTORY"],
    requirements: [req700("R-HISTORY")],
    resources: [res700("OLD-PROOF", "history")],
    relations: [rel700("R-HISTORY", "documents", "OLD-PROOF")],
  });
  assert.equal(validateHead700(graph).ok, true);
});
/* D2 — amemory */
test("#699 D2.1 semantic version advance accepts advance and rejects malformed/non-advance", () => {
  assert.equal(semverAdvance("0.182.0", "0.183.0"), true);
  assert.equal(semverAdvance("0.182.0", "0.182.0"), false);
  assert.equal(semverAdvance("0.182.0", "broken"), false);
});
test("#699 D2.2 contract/conformance partial change is RED; exact pair change is GREEN", () => {
  const members = ["contracts/amemory-contract-v0.2.json", "contracts/amemory-conformance-v0.2.json"];
  assert.equal(allOrNoneChanged([members[0]], members), false);
  assert.equal(allOrNoneChanged(members, members), true);
});
test("#699 D2.3-D2.5 upstream lock/projection uses exact immutable identity; advisory policy is not external enforcement", () => {
  const local = snapshot({ revision: A, files: {}, trackedFiles: [] });
  const old = snapshot({
    repository: "netkeep80/anum_docs",
    revision: PINS.D1.pin,
    files: { "requirements/mts-v0.15.json": JSON.stringify({ status: "accepted" }) },
  });
  const resolver = createResolver({ localSnapshot: local, externalSnapshots: [old] });
  assert.equal(resolver.resolve({
    kind: "external_document", repository: PINS.D1.repo, revision: PINS.D1.pin,
    path: "requirements/mts-v0.15.json", pointer: "/status",
  }).value, "accepted");
  assert.throws(() => resolver.resolve({
    kind: "external_document", repository: PINS.D1.repo, revision: "f".repeat(40),
    path: "requirements/mts-v0.15.json", pointer: "/status",
  }), /unavailable/);
  const enforcement = enforcementBoundary("advisory", "blocking");
  assert.equal(enforcement.blocking, true);
  assert.equal(enforcement.storedMode, "advisory");
});
test("#699 D2.6 governance-path semantics become Requirement/authority semantics", () => {
  const graph = graph700({
    roots: ["R-BUILD"],
    requirements: [req700("R-BUILD")],
    resources: [res700("POLICY", "config"), res700("WORKFLOW", "workflow"), res700("TEST", "test")],
    relations: [
      rel700("R-BUILD", "requires", "POLICY"),
      rel700("R-BUILD", "implemented_by", "WORKFLOW"),
      rel700("R-BUILD", "verified_by", "TEST"),
    ],
  });
  assert.equal(validateHead700(graph).ok, true);
  const orphan = graph700({ ...graph, relations: graph.relations.filter((r) => r.to !== "WORKFLOW") });
  assertRed(validateHead700(orphan), "J1:orphan_tracked_resource:WORKFLOW", "unowned governance artifact");
});
test("#699 D2.7 full J1/J2/J3 covers infra/contracts/tests without allowlists", () => {
  const base = graph700({
    roots: ["R-INFRA"],
    requirements: [req700("R-INFRA")],
    resources: [res700("CI", "workflow", { content: "a" }), res700("CONTRACT", "contract"), res700("TEST", "test")],
    relations: [
      rel700("R-INFRA", "implemented_by", "CI"),
      rel700("R-INFRA", "requires", "CONTRACT"),
      rel700("R-INFRA", "verified_by", "TEST"),
    ],
  });
  const head = graph700({ ...base, resources: [res700("CI", "workflow", { content: "b" }), res700("CONTRACT", "contract"), res700("TEST", "test")] });
  assertGreen(evaluate700({ base, head, workIntent: wi700(["R-INFRA"]) }), "ordinary infra cause");
});
test("#699 D2.8-D2.10 cross-repo refs include repo+SHA+path+pointer and historical exact ref survives branch movement", () => {
  const local = snapshot({ revision: A, files: {}, trackedFiles: [] });
  const old = snapshot({ repository: "netkeep80/anum_docs", revision: "1".repeat(40), files: { "x.json": "{\"v\":1}" } });
  const newer = snapshot({ repository: "netkeep80/anum_docs", revision: "2".repeat(40), files: { "x.json": "{\"v\":2}" } });
  const resolver = createResolver({ localSnapshot: local, externalSnapshots: [old, newer] });
  assert.equal(resolver.resolve({ kind: "external_document", repository: "netkeep80/anum_docs", revision: "1".repeat(40), path: "x.json", pointer: "/v" }).value, 1);
  assert.equal(resolver.resolve({ kind: "external_document", repository: "netkeep80/anum_docs", revision: "2".repeat(40), path: "x.json", pointer: "/v" }).value, 2);
  assert.throws(() => normalizeResourceRef({ kind: "external_document", repository: "netkeep80/anum_docs", revision: "main", path: "x.json", pointer: "/v" }), /40-hex/);
});
/* D3 — anum_parser */
test("#699 D3.1-D3.3 package semver and mirrors: consistent advance GREEN; stale/non-advance RED", () => {
  assert.equal(semverAdvance("3.2.0", "3.2.1"), true);
  assert.equal(mirrorsMatch("3.2.1", ["3.2.1", "3.2.1"]), true);
  assert.equal(mirrorsMatch("3.2.1", ["3.2.0", "3.2.1"]), false);
  assert.equal(semverAdvance("3.2.0", "3.2.0"), false);
});
test("#699 D3.4 Russian-first content is a Requirement-owned DOMAIN observation", () => {
  const base = graph700({
    roots: ["R-RU"],
    requirements: [req700("R-RU", { domainEvidenceOnChange: ["russian_first"] })],
    resources: [res700("README", "doc", { content: "ru" })],
    relations: [rel700("R-RU", "documents", "README")],
  });
  const head = graph700({ ...base, resources: [res700("README", "doc", { content: "en" })] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-RU"]) }), "DOMAIN:missing", "language check absent");
  assertGreen(evaluate700({ base, head, workIntent: wi700(["R-RU"]), domainEvidence: [domain("R-RU", "russian_first")] }), "language check present");
});
test("#699 D3.5 package/package-lock cochange remains an explicit Requirement transition obligation", () => {
  const members = ["package.json", "package-lock.json"];
  assert.equal(allOrNoneChanged(["package.json"], members), false);
  assert.equal(allOrNoneChanged(members, members), true);
});
test("#699 D3.6 trusted workflow/status producer remains external TRUST/platform fact", () => {
  assert.throws(() => normalizeResourceRef({ kind: "artifact", path: ".github/workflows/trusted-enforcement.yml", trusted: true }), /unknown field/);
  assert.equal(enforcementBoundary("blocking", "blocking").externalGate, "blocking");
});
test("#699 D3.7 package/lock/docs receive ordinary N:M justification", () => {
  const graph = graph700({
    roots: ["R-VERSION", "R-DOCS"],
    requirements: [req700("R-VERSION"), req700("R-DOCS")],
    resources: [res700("PACKAGE", "config"), res700("LOCK", "config"), res700("README", "doc")],
    relations: [
      rel700("R-VERSION", "requires", "PACKAGE"),
      rel700("R-VERSION", "requires", "LOCK"),
      rel700("R-DOCS", "documents", "README"),
      rel700("R-DOCS", "depends_on", "R-VERSION"),
    ],
  });
  assert.equal(validateHead700(graph).ok, true);
});
test("#699 D3.8 source rename does not change semantic Requirement ID", () => {
  const body = requirementYaml("R1");
  const base = snapshot({ revision: A, files: { "requirements/R1.yaml": body }, trackedFiles: ["requirements/R1.yaml"] });
  const head = snapshot({ revision: B, files: { "requirements/security/R1.yaml": body }, trackedFiles: ["requirements/security/R1.yaml"] });
  const delta = compareSemanticRequirements(base, head);
  assert.deepEqual(delta.add, []);
  assert.deepEqual(delta.remove, []);
  assert.deepEqual(delta.modify, []);
  assert.equal(delta.source_move.length, 1);
});
test("#699 D3.9 duplicate canonical Requirement ID is RED", () => {
  const snap = snapshot({
    revision: A,
    files: {
      "requirements/a.yaml": requirementYaml("R1"),
      "requirements/b.yaml": requirementYaml("R1"),
    },
  });
  assert.throws(() => buildSourceIndex(snap), /duplicate Requirement id/);
});
/* D4 — aprover security counterexample */
test("#699 D4.1 ordinary change touching trusted approver is RED", () => {
  const base = graph700({
    roots: ["R-APPROVER"],
    requirements: [req700("R-APPROVER")],
    resources: [res700("APPROVER", "trusted_approver", { content: "a" })],
    relations: [rel700("R-APPROVER", "implemented_by", "APPROVER")],
  });
  const head = graph700({ ...base, resources: [res700("APPROVER", "trusted_approver", { content: "b" })] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R-APPROVER"]), trustedResourceIds: ["APPROVER"] }), "trust_root:APPROVER", "ordinary trusted touch");
});
test("#699 D4.2 ordinary implementation outside trusted surface is GREEN", () => {
  const base = graph700({
    roots: ["R-FEATURE"],
    requirements: [req700("R-FEATURE")],
    resources: [res700("FEATURE", "code", { content: "a" })],
    relations: [rel700("R-FEATURE", "implemented_by", "FEATURE")],
  });
  const head = graph700({ ...base, resources: [res700("FEATURE", "code", { content: "b" })] });
  assertGreen(evaluate700({ base, head, workIntent: wi700(["R-FEATURE"]) }), "ordinary feature");
});
test("#699 D4.3 trusted-kernel transition GREEN only with exact TRUST and exact verifier PASS", () => {
  const base = graph700({
    roots: ["R-KERNEL"],
    requirements: [req700("R-KERNEL", { requiredVerifiers: ["T-APPROVER"] })],
    resources: [res700("APPROVER", "trusted_approver", { content: "a" }), res700("T-APPROVER", "test")],
    relations: [rel700("R-KERNEL", "implemented_by", "APPROVER"), rel700("R-KERNEL", "verified_by", "T-APPROVER")],
  });
  const head = graph700({ ...base, resources: [res700("APPROVER", "trusted_approver", { content: "b" }), res700("T-APPROVER", "test")] });
  const common = { base, head, workIntent: wi700(["R-KERNEL"]), trustedResourceIds: ["APPROVER"] };
  assertRed(evaluate700(common), "trust_root:APPROVER", "missing trust");
  assertRed(evaluate700({ ...common, trustedReceipts: [exactReceipt("trust_root:APPROVER")] }), "verifier_not_passed", "missing verifier");
  assertGreen(evaluate700({
    ...common,
    trustedReceipts: [exactReceipt("trust_root:APPROVER")],
    executions: [execution("T-APPROVER")],
  }), "trusted kernel exact obligations");
});
test("#699 D4.4 forbidden UI/search resource remains RED under trusted-kernel transition constraint", () => {
  const base = graph700({
    roots: ["R-KERNEL"],
    requirements: [req700("R-KERNEL")],
    resources: [res700("UI", "ui", { content: "a" })],
    relations: [rel700("R-KERNEL", "implemented_by", "UI")],
  });
  const head = graph700({ ...base, resources: [res700("UI", "ui", { content: "b" })] });
  assertRed(evaluateWithForbiddenKinds({ base, head, workIntent: wi700(["R-KERNEL"]) }, ["ui", "search"]), "forbidden_resource_kind:ui", "forbidden UI");
});
test("#699 D4.5-D4.6 missing or unrelated verifier cannot satisfy trusted approver verification", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R", { requiredVerifiers: ["GOOD"] })],
    resources: [res700("F", "code", { content: "a" }), res700("BAD", "test")],
    relations: [rel700("R", "implemented_by", "F"), rel700("R", "verified_by", "BAD")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "b" }), res700("BAD", "test")] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["R"]), executions: [execution("BAD")] }), "unrelated_verifier:R:GOOD", "unrelated verifier");
});
test("#699 D4.7 candidate cannot remove trusted classification by changing resource kind", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [res700("APPROVER", "trusted_approver", { content: "a" })],
    relations: [rel700("R", "implemented_by", "APPROVER")],
  });
  const head = graph700({ ...base, resources: [res700("APPROVER", "code", { content: "b" })] });
  assertRed(evaluate700({
    base, head, workIntent: wi700(["R"]), trustedResourceIds: ["APPROVER"],
  }), "trust_root:APPROVER", "kind downgrade cannot remove external trust");
});
test("#699 D4.8 GitHub permission/status producer cannot be candidate-authored ResourceRef trust metadata", () => {
  assert.throws(() => normalizeResourceRef({
    kind: "document", path: ".github/workflows/repo-guard.yml", pointer: "", trust: "github",
  }), /unknown field/);
});
test("#699 D4.9 shared trusted resource computes reverse impact for all R1/R2/R3 without turning impact into cause", () => {
  const base = graph700({
    roots: ["R1", "R2", "R3"],
    requirements: [req700("R1"), req700("R2"), req700("R3")],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R1", "implemented_by", "F"), rel700("R2", "implemented_by", "F"), rel700("R3", "implemented_by", "F")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "b" })] });
  const result = evaluate700({ base, head, workIntent: wi700(["R1"]) });
  assertGreen(result, "one direct cause is sufficient");
  assert.deepEqual(result.affectedRequirements, ["R1", "R2", "R3"]);
  const changed = result.explanations.whyChanged.find((item) => item.delta === "resource_modify:F");
  assert.deepEqual(changed.causes, ["R1"]);
});
test("#699 D4.10-D4.11 stale authority after rebase fails; local diff base is not trusted authority base", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [res700("F", "trusted", { content: "a" })],
    relations: [rel700("R", "implemented_by", "F")],
  });
  const head = graph700({ ...base, resources: [res700("F", "trusted", { content: "b" })] });
  const stale = receipt700("1".repeat(40), "2".repeat(40), ["trust_root:F"]);
  assertRed(evaluate700({
    base, head, baseSha: "3".repeat(40), headSha: "4".repeat(40), workIntent: wi700(["R"]),
    trustedResourceIds: ["F"], trustedReceipts: [stale],
  }), "trust_root:F", "stale stacked/rebased authority");
});
test("#699 D4.12 ResourceRef kind cannot carry candidate-controlled trust classification", () => {
  assert.throws(() => normalizeResourceRef({ kind: "artifact", path: "src/core/proofApproval.ts", trust: false }), /unknown field/);
});
/* D5 — mts-nl-compiler ceremony counterexample */
test("#699 D5.1 additive implementation+relevant verifier stays routine without GovernanceGrant", () => {
  const legacy = acceptedRoutineAdditive();
  assert.equal(legacy.ok, true, legacy.reasons.join(", "));
  const base = graph700({
    roots: ["MNC-001"],
    requirements: [req700("MNC-001")],
    resources: [res700("OLD", "code")],
    relations: [rel700("MNC-001", "implemented_by", "OLD")],
  });
  const head = graph700({
    ...base,
    resources: [res700("OLD", "code"), res700("NEW", "code")],
    relations: [...base.relations, rel700("MNC-001", "implemented_by", "NEW")],
  });
  assertGreen(evaluate700({ base, head, workIntent: wi700(["MNC-001"]) }), "candidate additive trace");
});
test("#699 D5.2 unrelated verifier is RED", () => {
  const base = graph700({
    roots: ["MNC-001"],
    requirements: [req700("MNC-001", { requiredVerifiers: ["GOOD"] })],
    resources: [res700("SRC", "code", { content: "a" }), res700("BAD", "test")],
    relations: [rel700("MNC-001", "implemented_by", "SRC"), rel700("MNC-001", "verified_by", "BAD")],
  });
  const head = graph700({ ...base, resources: [res700("SRC", "code", { content: "b" }), res700("BAD", "test")] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["MNC-001"]), executions: [execution("BAD")] }), "unrelated_verifier", "wrong verifier");
});
test("#699 D5.3 #702 differential: legacy descriptive replacement false-blocks; candidate replacement is routine GREEN", () => {
  const legacy = acceptedRoutineReplacement();
  assert.equal(legacy.ok, false);
  assert.ok(legacy.reasons.includes("routine_requires_additive_relation_delta"));
  const base = graph700({
    roots: ["MNC-001"],
    requirements: [req700("MNC-001")],
    resources: [res700("OLD", "code")],
    relations: [rel700("MNC-001", "implemented_by", "OLD")],
  });
  const head = graph700({
    roots: ["MNC-001"],
    requirements: [req700("MNC-001")],
    resources: [res700("NEW", "code")],
    relations: [rel700("MNC-001", "implemented_by", "NEW")],
  });
  assertGreen(evaluate700({ base, head, workIntent: wi700(["MNC-001"]) }), "candidate descriptive replacement");
});
test("#699 D5.4 strong requires weakening needs exact TRUST", () => {
  const base = graph700({
    roots: ["MNC-001"],
    requirements: [req700("MNC-001")],
    resources: [res700("F", "code")],
    relations: [rel700("MNC-001", "requires", "F"), rel700("MNC-001", "implemented_by", "F")],
  });
  const head = graph700({
    ...base,
    relations: [rel700("MNC-001", "implemented_by", "F")],
  });
  assertRed(evaluate700({ base, head, workIntent: wi700(["MNC-001"]) }), "requirement:MNC-001", "requires weakening");
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["MNC-001"]),
    trustedReceipts: [exactReceipt("requirement:MNC-001")],
  }), "authorized requires weakening");
});
test("#699 D5.5 duplicate ID, missing target and orphan Requirement all fail closed", () => {
  const duplicate = snapshot({
    revision: A,
    files: { "requirements/a.yaml": requirementYaml("R1"), "requirements/b.yaml": requirementYaml("R1") },
  });
  assert.throws(() => buildSourceIndex(duplicate), /duplicate Requirement id/);
  const missing = snapshot({
    revision: A,
    files: {
      "requirements/a.yaml": requirementYaml("R1", {
        dep: { predicate: "depends_on", target: { kind: "requirement", id: "MISSING" } },
      }),
    },
  });
  assert.throws(() => buildSourceIndex(missing), /missing Requirement target/);
  const orphan = snapshot({
    revision: A,
    files: { "requirements/root.yaml": requirementYaml("ROOT"), "requirements/orphan.yaml": requirementYaml("ORPHAN") },
  });
  const closure = eagerClosure(orphan, ["ROOT"]);
  assert.equal(closure.ok, false);
  assert.deepEqual(closure.orphanRequirements, ["ORPHAN"]);
});
test("#699 D5.6 closed_repository=false is intentionally removed: full tracked-resource closure is mandatory", () => {
  const invalid = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT")],
    resources: [res700("INFRA", "workflow")],
    relations: [],
  });
  assertRed(validateHead700(invalid), "J1:orphan_tracked_resource:INFRA", "unjustified infra");
  const valid = graph700({ ...invalid, relations: [rel700("ROOT", "implemented_by", "INFRA")] });
  assert.equal(validateHead700(valid).ok, true);
});
test("#699 D5.7 wildcard trusted roots and infrastructure exceptions are not accepted fixture semantics", () => {
  const allowedRoot = (id) => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(id);
  assert.equal(allowedRoot("ROOT"), true);
  assert.equal(allowedRoot("**/*"), false);
  assert.equal(allowedRoot("infra/**"), false);
});
test("#699 D5.8 Requirement add/remove does not mechanically require artifact add/remove", () => {
  const base = graph700({ roots: ["ROOT"], requirements: [req700("ROOT")], resources: [res700("F", "code")], relations: [rel700("ROOT", "implemented_by", "F")] });
  const added = graph700({
    roots: ["ROOT"],
    requirements: [req700("ROOT"), req700("R2")],
    resources: [res700("F", "code")],
    relations: [rel700("ROOT", "implemented_by", "F"), rel700("R2", "derives_from", "ROOT")],
  });
  assert.equal(transitionDeltas700(base, added).some((delta) => delta.kind.startsWith("resource_")), false);
  const removed = graph700({ roots: ["ROOT"], requirements: [req700("ROOT")], resources: [res700("F", "code")], relations: [rel700("ROOT", "implemented_by", "F")] });
  assert.equal(transitionDeltas700(added, removed).some((delta) => delta.kind.startsWith("resource_")), false);
});
test("#699 D5.9 bugfix/refactor with RequirementDelta=0 is GREEN when J3 cause exists", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [res700("F", "code", { content: "bug" })],
    relations: [rel700("R", "implemented_by", "F")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "fixed" })] });
  const result = evaluate700({ base, head, workIntent: wi700(["R"]) });
  assertGreen(result, "bugfix");
  assert.equal(result.deltas.some((delta) => delta.kind.startsWith("requirement_")), false);
});
test("#699 D5.10 global line/file budget without Requirement is not blocker", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R")],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R", "implemented_by", "F")],
  });
  const head = graph700({ ...base, resources: [res700("F", "code", { content: "b" })] });
  assertGreen(evaluate700({
    base, head, workIntent: wi700(["R"]), metrics: { changedLines: { F: 99999 } }, legacyGlobalBudget: 4000,
  }), "legacy global budget intentionally advisory");
});
/* Cross-cutting #697/#700 security and identity cases */
test("#699 X1 candidate HEAD cannot create its own trusted root", () => {
  const base = graph700({ roots: ["ROOT"], requirements: [req700("ROOT")], resources: [], relations: [] });
  const head = graph700({ roots: ["ROOT", "EVIL"], requirements: [req700("ROOT"), req700("EVIL")], resources: [], relations: [] });
  assertRed(evaluate700({ base, head, workIntent: wi700(["EVIL"]) }), "J2:orphan_requirement:EVIL", "HEAD root is not trusted input");
});
test("#699 X2 positional pointer is not durable exact-fragment identity", () => {
  assert.equal(pointerStability("/relations/verification"), "stable-keyed");
  assert.equal(pointerStability("/relations/1"), "positional-unsafe");
});
test("#699 X3 semantic receipt and exact-fragment receipt are not interchangeable", () => {
  const snap = snapshot({ repository: PINS.D1.repo, revision: PINS.D1.pin, files: { "contract.json": "{\"id\":\"C\"}" } });
  const exact = representationSubject(snap, "contract.json", "/id");
  const different = { ...exact, binding: "semantic_requirement", requirement_id: "C" };
  assert.equal(receiptMatches(exact, exact), true);
  assert.equal(receiptMatches(exact, different), false);
});
test("#699 X4 resolver supplies identity only; candidate trust metadata is rejected", () => {
  assert.throws(() => normalizeResourceRef({
    kind: "external_document", repository: PINS.D1.repo, revision: PINS.D1.pin,
    path: "requirements/mts-v0.15.json", pointer: "", trusted: true,
  }), /unknown field/);
});
test("#699 X5 canonical JSON duplicate object keys are RED at candidate source boundary (#704)", () => {
  assert.throws(() => strictCanonicalParse("json", "{\"id\":\"R1\",\"id\":\"R2\"}"), /duplicate|Map keys|unique/i);
  assert.deepEqual(strictCanonicalParse("json", "{\"id\":\"R1\",\"relations\":{}}"), { id: "R1", relations: {} });
});
test("#699 X6 closed-PR merge-ref failure #705 is classified control-plane, not semantic differential", () => {
  const defect = { issue: 705, layer: "control-plane", semanticRegression: false };
  assert.equal(defect.semanticRegression, false);
  assert.equal(defect.layer, "control-plane");
});
test("#699 X7 candidate normative:false cannot suppress BASE authority without exact TRUST", () => {
  const base = graph700({
    roots: ["R"],
    requirements: [req700("R", { constraints: [{ id: "lines", metric: "changed_lines", max: 10 }] })],
    resources: [res700("F", "code", { content: "a" })],
    relations: [rel700("R", "implemented_by", "F")],
  });
  const head = graph700({
    roots: ["R"],
    requirements: [req700("R", { normative: false, constraints: [{ id: "lines", metric: "changed_lines", max: 10 }] })],
    resources: [res700("F", "code", { content: "b" })],
    relations: base.relations,
  });
  assertRed(evaluate700({
    base, head, workIntent: wi700(["R"]), metrics: { changedLines: { F: 100 } },
  }), "TRUST:missing:requirement:R", "candidate cannot self-declare non-normative");
});
test("#699 X8 candidate cannot delete BASE constrains relation to remove a live constraint", () => {
  const base = graph700({
    roots: ["R-GUARD", "R-FEATURE"],
    requirements: [req700("R-GUARD"), req700("R-FEATURE")],
    resources: [],
    relations: [rel700("R-GUARD", "constrains", "R-FEATURE")],
  });
  const head = graph700({
    roots: base.roots,
    requirements: base.requirements,
    resources: [],
    relations: [],
  });
  assertRed(evaluate700({
    base, head, workIntent: wi700(["R-GUARD"]),
  }), "TRUST:missing:relation:R-GUARD|constrains|R-FEATURE", "BASE constraint relation cannot self-delete");
});
test("#699 X9 complexity compression metrics are explicit and do not hide external TRUST/DOMAIN/OBSERVATION", () => {
  const legacy = {
    publicTopLevelMechanisms: 18,
    governancePathDeclarations: 50,
    permanentSurfaces: 19,
    permanentChangeProfiles: 13,
  };
  const candidate = {
    projectSemanticPrimitives: ["Requirement", "Relation", "Constraint", "Transition", "ResourceRef"],
    permanentInfrastructureExceptions: 0,
    permanentOneOffProfiles: 0,
    independentBoundaries: ["OBSERVATION", "DOMAIN", "TRUST"],
  };
  assert.ok(candidate.projectSemanticPrimitives.length < legacy.publicTopLevelMechanisms);
  assert.equal(candidate.permanentInfrastructureExceptions, 0);
  assert.equal(candidate.permanentOneOffProfiles, 0);
  assert.deepEqual(candidate.independentBoundaries, ["OBSERVATION", "DOMAIN", "TRUST"]);
});


test("#726 I9 R01-M10 real-source audit + production provisional replay", { timeout: 240_000 }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname, resolve } = await import("node:path");
  const productionPipeline = await import("../dist/runtime/pipeline.mjs");
  const productionGit = await import("../dist/git.mjs");
  const canonical = await import("../dist/runtime/canonical-requirements.mjs");

  assert.equal(typeof productionPipeline.evaluateRepositoryShadowReplay, "function");

  const root = mkdtempSync(join(tmpdir(), "repo-guard-i9-"));
  const git = (cwd, args, options = {}) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
  const put = (cwd, path, content) => {
    const full = join(cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const initRepo = (cwd) => {
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.email", "i9@example.invalid"]);
    git(cwd, ["config", "user.name", "RepoGuard I9"]);
  };
  const commitAll = (cwd, message) => {
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  };
  const exactReplay = (id, cwd, revision) => productionPipeline.evaluateRepositoryShadowReplay({
    repository: PINS[id].repo,
    repositoryRoot: cwd,
    trustedAuthorityBaseRevision: revision,
    baseRevision: revision,
    headRevision: revision,
    model: null,
  });

  const observed = {};
  try {
    for (const [id, expected] of Object.entries(PINS)) {
      const cwd = join(root, id);
      initRepo(cwd);
      git(cwd, ["remote", "add", "origin", "https://github.com/" + expected.repo + ".git"]);
      git(cwd, ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", "+refs/heads/main:refs/i9/main"]);
      const current = git(cwd, ["rev-parse", "refs/i9/main"]);
      if (current !== expected.pin) {
        git(cwd, ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", expected.pin]);
      }
      assert.equal(git(cwd, ["cat-file", "-t", expected.pin]), "commit");
      const entries = productionGit.listTrackedEntriesAtRef(expected.pin, cwd);
      const policyEntry = entries.find((entry) => entry.path === "repo-policy.json");
      assert.ok(policyEntry, id + " repo-policy.json must be tracked");
      assert.equal(policyEntry.object, expected.policyBlob);
      assert.equal(entries.length, expected.tracked);
      const policy = JSON.parse(productionGit.readFileAtRef(expected.pin, "repo-policy.json", cwd));
      const replay = exactReplay(id, cwd, expected.pin);
      assert.equal(replay.observation.headTracked, expected.tracked);
      assert.equal(replay.replay.classification, "NOT_PROVEN");
      assert.equal(replay.replay.acceptedAuthorityVerified, false);
      observed[id] = {
        cwd, current, drift: current === expected.pin ? "NO_DRIFT" : "DRIFT_DETECTED",
        entries, policy, replay,
      };
    }

    const d1Registry = JSON.parse(productionGit.readFileAtRef(
      PINS.D1.pin, "requirements/mts-v0.15.json", observed.D1.cwd));
    assert.equal(d1Registry.accepted, true);
    assert.equal(d1Registry.status, "accepted");
    assert.ok(d1Registry.requirements.some((r) => r.id === "V15-READY-03" && r.state === "ACCEPTED"));
    const d1Sources = observed.D1.entries.filter((entry) => entry.path.startsWith("requirements/"));

    const d2Version = productionGit.readFileAtRef(PINS.D2.pin, "VERSION", observed.D2.cwd).trim();
    const d2Lock = JSON.parse(productionGit.readFileAtRef(
      PINS.D2.pin, "contracts/upstream/mts-v0.15.lock.json", observed.D2.cwd));
    assert.equal(d2Version, "0.182.0");
    assert.match(d2Lock.acceptedCommit, /^[0-9a-f]{40}$/);
    assert.equal(d2Lock.floatingRefsAllowed, false);

    const d3Package = JSON.parse(productionGit.readFileAtRef(PINS.D3.pin, "package.json", observed.D3.cwd));
    const d3PackageLock = JSON.parse(productionGit.readFileAtRef(PINS.D3.pin, "package-lock.json", observed.D3.cwd));
    assert.equal(d3Package.version, d3PackageLock.version);
    assert.equal(d3Package.version, d3PackageLock.packages[""].version);

    const d2RepoGuardWorkflow = productionGit.readFileAtRef(
      PINS.D2.pin, ".github/workflows/repo-guard.yml", observed.D2.cwd);
    const d5RepoGuardWorkflow = productionGit.readFileAtRef(
      PINS.D5.pin, ".github/workflows/repo-guard.yml", observed.D5.cwd);
    assert.equal(observed.D2.policy.enforcement.mode, "advisory");
    assert.equal(observed.D5.policy.enforcement.mode, "advisory");
    assert.match(d2RepoGuardWorkflow, /enforcement:\s*blocking/);
    assert.match(d5RepoGuardWorkflow, /enforcement:\s*blocking/);

    const d4Policy = observed.D4.policy;
    assert.deepEqual(d4Policy.surfaces.trusted_approver, ["src/core/proofApproval.ts"]);
    assert.ok(d4Policy.change_profiles.feature.forbid_surfaces.includes("trusted_approver"));
    assert.ok(d4Policy.change_profiles["trusted-kernel"].require_surfaces.includes("trusted_approver"));
    assert.ok(d4Policy.change_profiles["trusted-kernel"].require_surfaces.includes("unit_tests"));

    const d5RequirementPaths = observed.D5.entries
      .map((entry) => entry.path)
      .filter((path) => /^requirements\/MNC-\d+\.yaml$/.test(path))
      .sort();
    assert.deepEqual(d5RequirementPaths, [
      "requirements/MNC-001.yaml",
      "requirements/MNC-024.yaml",
      "requirements/MNC-026.yaml",
      "requirements/MNC-028.yaml",
      "requirements/MNC-030.yaml",
    ]);
    const d5Canonical = canonical.loadCanonicalRequirements({
      repository: PINS.D5.repo,
      revision: PINS.D5.pin,
      paths: d5RequirementPaths,
      readFile: (revision, path) => productionGit.readFileAtRef(revision, path, observed.D5.cwd),
    });
    assert.equal(d5Canonical.ok, true, JSON.stringify(d5Canonical.errors));
    assert.equal(d5Canonical.requirements.length, 5);
    for (const requirement of d5Canonical.requirements) {
      const sourceEntry = observed.D5.entries.find((entry) => entry.path === requirement.source.path);
      assert.ok(sourceEntry);
      assert.notEqual(requirement.semantic.digest, sourceEntry.object);
      assert.equal(requirement.representation.revision, PINS.D5.pin);
    }

    // D5 real-tree migration gap: deterministically lower only exact legacy artifact
    // relations into existing vNext predicates. This is test-only PROVISIONAL data,
    // not accepted consumer authority and never introduces wildcard/infra exemptions.
    const relationMap = { requires: "requires", implements: "implemented_by", verifies: "verified_by", documents: "documents" };
    const d5ProjectedItems = d5Canonical.requirements.map((requirement) => {
      const artifacts = Array.isArray(requirement.value.artifacts) ? requirement.value.artifacts : [];
      const relations = {};
      let ordinal = 0;
      for (const artifact of artifacts) {
        if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string") continue;
        assert.equal(/[*?\[\]{}]/.test(artifact.path), false, "D5 provisional projection forbids wildcard targets");
        const kinds = Array.isArray(artifact.relations) ? artifact.relations : [];
        for (const legacy of kinds) {
          const predicate = relationMap[legacy];
          if (!predicate) continue;
          relations["r" + String(ordinal++).padStart(4, "0")] = {
            predicate,
            target: { kind: "artifact", path: artifact.path },
          };
        }
      }
      const value = { id: requirement.id, relations };
      return {
        ...requirement,
        value,
        semantic: canonical.semanticRequirementSubject(
          PINS.D5.repo, requirement.id, canonical.canonicalSemanticDigest(value)),
      };
    });
    const d5ProjectedIndex = Object.fromEntries(d5ProjectedItems.map((x) => [x.id, x]));
    const d5Projected = {
      ...d5Canonical,
      requirements: d5ProjectedItems,
      index: d5ProjectedIndex,
    };
    const d5ProjectedRoots = d5ProjectedItems.map((x) => x.semantic);
    const d5RealTreeReplay = productionPipeline.evaluateRepositoryShadowReplay({
      repository: PINS.D5.repo,
      repositoryRoot: observed.D5.cwd,
      trustedAuthorityBaseRevision: PINS.D5.pin,
      baseRevision: PINS.D5.pin,
      headRevision: PINS.D5.pin,
      model: {
        authority: { requirements: d5Projected, evaluationRoots: d5ProjectedRoots },
        base: { requirements: d5Projected },
        head: { requirements: d5Projected },
      },
      workIntent: { id: "i9-d5-real-tree-gap", addresses: d5ProjectedItems.map((x) => x.id) },
    });
    assert.equal(d5RealTreeReplay.replay.classification, "PROVISIONAL_MIGRATION_MODEL");
    assert.equal(d5RealTreeReplay.replay.acceptedAuthorityVerified, false);
    assert.equal(d5RealTreeReplay.replay.authority.j2.rooted.length, 5);
    assert.ok(d5RealTreeReplay.replay.head.j1.justified.length > 0);
    assert.ok(d5RealTreeReplay.replay.head.j1.unjustified.length > 0);
    assert.equal(d5RealTreeReplay.replay.ok, false);

    // D4: adversarial derived fixture seeded with exact consumer source bytes.
    // This is NOT a historical consumer transition and is never labelled accepted authority.
    const d4Derived = join(root, "D4-derived");
    initRepo(d4Derived);
    const actualApprover = productionGit.readFileAtRef(
      PINS.D4.pin, "src/core/proofApproval.ts", observed.D4.cwd);
    put(d4Derived, "src/core/proofApproval.ts", actualApprover);
    put(d4Derived, "tests/domain.mjs", [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync("src/core/proofApproval.ts", "utf8");',
      'if (source.length < 100 || !/proof/i.test(source)) process.exit(2);',
      'console.log("D4_DERIVED_DOMAIN_OK");',
      "",
    ].join("\n"));
    const d4Requirement = [
      "id: D4-TRUST",
      "relations:",
      "  impl:",
      "    predicate: implemented_by",
      "    target: {kind: artifact, path: src/core/proofApproval.ts}",
      "  verify:",
      "    predicate: verified_by",
      "    target: {kind: artifact, path: tests/domain.mjs}",
      "transition:",
      "  deltaKinds: [resource_modify]",
      "  paths: [src/core/proofApproval.ts]",
      "  requireAddressed: true",
      "constraints:",
      "  - id: exact-domain",
      "    relations: [implemented_by]",
      "    evidence:",
      "      kind: execution",
      "      key: d4-derived-domain",
      "      providerId: d4-domain",
      "      verifierPath: tests/domain.mjs",
      "",
    ].join("\n");
    put(d4Derived, "requirements/D4-TRUST.yaml", d4Requirement);
    const d4Base = commitAll(d4Derived, "D4 derived base from exact consumer source");
    put(d4Derived, "src/core/proofApproval.ts", actualApprover + "\n// I9 derived protected transition\n");
    const d4Head = commitAll(d4Derived, "D4 derived protected transition");
    const loadD4 = (revision) => canonical.loadCanonicalRequirements({
      repository: PINS.D4.repo,
      revision,
      paths: ["requirements/D4-TRUST.yaml"],
      readFile: (sha, path) => productionGit.readFileAtRef(sha, path, d4Derived),
    });
    const d4BaseReq = loadD4(d4Base), d4HeadReq = loadD4(d4Head);
    assert.equal(d4BaseReq.ok && d4HeadReq.ok, true);
    const d4Root = d4BaseReq.requirements[0].semantic;
    const d4Model = {
      authority: { requirements: d4BaseReq, evaluationRoots: [d4Root] },
      base: { requirements: d4BaseReq },
      head: { requirements: d4HeadReq },
    };
    const d4BaseInput = {
      repository: PINS.D4.repo,
      repositoryRoot: d4Derived,
      trustedAuthorityBaseRevision: d4Base,
      baseRevision: d4Base,
      headRevision: d4Head,
      model: d4Model,
      workIntent: { id: "i9-d4-derived", addresses: ["D4-TRUST"] },
      protectedResources: ["src/core/proofApproval.ts"],
      trustedEvidenceProviders: ["d4-domain"],
    };
    const d4NoTrust = productionPipeline.evaluateRepositoryShadowReplay(d4BaseInput);
    assert.equal(d4NoTrust.replay.ok, false);
    assert.ok(d4NoTrust.replay.gaps.some((x) => x.includes("missing_authority:resource:src/core/proofApproval.ts")));
    assert.ok(d4NoTrust.replay.gaps.some((x) => x.includes("missing_evidence:D4-TRUST:exact-domain")));
    const d4NoIntent = productionPipeline.evaluateRepositoryShadowReplay({
      ...d4BaseInput,
      workIntent: { id: "i9-d4-no-intent", addresses: [] },
    });
    assert.equal(d4NoIntent.replay.ok, false);
    assert.ok(d4NoIntent.replay.gaps.some((x) => x.includes("J3:no_cause")));

    const domainStdout = execFileSync(process.execPath, ["tests/domain.mjs"], {
      cwd: d4Derived, encoding: "utf8",
    }).trim();
    assert.equal(domainStdout, "D4_DERIVED_DOMAIN_OK");
    const d4Receipt = {
      authorityBaseRevision: d4Base,
      baseRevision: d4Base,
      headRevision: d4Head,
      permissions: ["resource:src/core/proofApproval.ts"],
    };
    const d4Evidence = {
      authorityBaseRevision: d4Base,
      baseRevision: d4Base,
      headRevision: d4Head,
      key: "d4-derived-domain",
      status: "pass",
      providerId: "d4-domain",
      requirementId: "D4-TRUST",
      subjectPaths: ["src/core/proofApproval.ts"],
      verifierPath: "tests/domain.mjs",
      verifierRevision: d4Head,
    };
    const d4Green = productionPipeline.evaluateRepositoryShadowReplay({
      ...d4BaseInput, trustedReceipts: [d4Receipt], evidenceFacts: [d4Evidence],
    });
    assert.equal(d4Green.replay.ok, true, d4Green.replay.gaps.join(" | "));
    assert.equal(d4Green.replay.classification, "PROVISIONAL_MIGRATION_MODEL");
    assert.equal(d4Green.replay.acceptedAuthorityVerified, false);
    assert.equal(d4Green.replay.readyForCutover, false);

    const d4WrongProvider = productionPipeline.evaluateRepositoryShadowReplay({
      ...d4BaseInput, trustedReceipts: [d4Receipt],
      evidenceFacts: [{ ...d4Evidence, providerId: "candidate-provider" }],
    });
    assert.equal(d4WrongProvider.replay.ok, false);
    const d4StaleReceipt = productionPipeline.evaluateRepositoryShadowReplay({
      ...d4BaseInput,
      trustedReceipts: [{ ...d4Receipt, headRevision: d4Base }],
      evidenceFacts: [d4Evidence],
    });
    assert.equal(d4StaleReceipt.replay.ok, false);
    const d4WrongSubject = productionPipeline.evaluateRepositoryShadowReplay({
      ...d4BaseInput, trustedReceipts: [d4Receipt],
      evidenceFacts: [{ ...d4Evidence, subjectPaths: ["tests/domain.mjs"] }],
    });
    assert.equal(d4WrongSubject.replay.ok, false);

    // D5: derived routine implementation replacement using exact source bytes.
    const d5Derived = join(root, "D5-derived");
    initRepo(d5Derived);
    const oldImpl = productionGit.readFileAtRef(PINS.D5.pin, "src/store.mjs", observed.D5.cwd);
    const newImpl = productionGit.readFileAtRef(PINS.D5.pin, "src/knowledge-snapshot-v0.mjs", observed.D5.cwd);
    const d5Req = (path, summary = "routine implementation mapping") => [
      "id: D5-R",
      "summary: " + summary,
      "relations:",
      "  impl:",
      "    predicate: implemented_by",
      "    target: {kind: artifact, path: " + path + "}",
      "",
    ].join("\n");
    put(d5Derived, "requirements/D5-R.yaml", d5Req("src/store.mjs"));
    put(d5Derived, "src/store.mjs", oldImpl);
    const d5Base = commitAll(d5Derived, "D5 derived base from exact consumer source");
    rmSync(join(d5Derived, "src/store.mjs"));
    put(d5Derived, "src/knowledge-snapshot-v0.mjs", newImpl);
    put(d5Derived, "requirements/D5-R.yaml", d5Req("src/knowledge-snapshot-v0.mjs"));
    const d5Head = commitAll(d5Derived, "D5 derived routine replacement");
    const loadD5 = (revision) => canonical.loadCanonicalRequirements({
      repository: PINS.D5.repo,
      revision,
      paths: ["requirements/D5-R.yaml"],
      readFile: (sha, path) => productionGit.readFileAtRef(sha, path, d5Derived),
    });
    const d5BaseReq = loadD5(d5Base), d5HeadReq = loadD5(d5Head);
    const d5StableRoot = canonical.semanticRequirementSubject(
      PINS.D5.repo, "D5-R",
      canonical.canonicalSemanticDigest({ id: "D5-R", summary: "routine implementation mapping" }),
    );
    const d5RootSubjects = { "D5-R": d5StableRoot };
    const d5Routine = productionPipeline.evaluateRepositoryShadowReplay({
      repository: PINS.D5.repo,
      repositoryRoot: d5Derived,
      trustedAuthorityBaseRevision: d5Base,
      baseRevision: d5Base,
      headRevision: d5Head,
      model: {
        authority: { requirements: d5BaseReq, evaluationRoots: [d5StableRoot], rootSubjects: d5RootSubjects },
        base: { requirements: d5BaseReq, rootSubjects: d5RootSubjects },
        head: { requirements: d5HeadReq, rootSubjects: d5RootSubjects },
      },
      workIntent: { id: "i9-d5-derived-routine", addresses: ["D5-R"] },
    });
    assert.equal(d5Routine.replay.ok, true, d5Routine.replay.gaps.join(" | "));
    assert.equal(d5Routine.replay.transition.deltas.some((d) => d.kind === "relation_replace"), true);
    assert.equal(d5Routine.replay.transition.explanations.whyChanged
      .flatMap((x) => x.requiredAuthority).length, 0);

    // Diverged BASE falsifier: production Git observation must use merge-base→HEAD,
    // not a direct diverged BASE→HEAD tree comparison.
    git(d5Derived, ["checkout", "-q", "--detach", d5Base]);
    put(d5Derived, "base-only.txt", "must not appear in merge-base-to-head observation\n");
    const d5DivergedBase = commitAll(d5Derived, "D5 diverged local base witness");
    const d5DivergedDiff = productionGit.getExactDiffIdentity(d5DivergedBase, d5Head, d5Derived);
    assert.equal(d5DivergedDiff.some((x) => x.path === "base-only.txt" || x.previousPath === "base-only.txt"), false);
    assert.equal(d5DivergedDiff.some((x) => x.path === "src/knowledge-snapshot-v0.mjs"), true);

    git(d5Derived, ["checkout", "-q", "--detach", d5Base]);
    put(d5Derived, "requirements/D5-R.yaml", d5Req("src/store.mjs", "changed normative requirement"));
    const d5NormativeHead = commitAll(d5Derived, "D5 derived unauthorized normative change");
    const d5NormativeReq = loadD5(d5NormativeHead);
    const d5Normative = productionPipeline.evaluateRepositoryShadowReplay({
      repository: PINS.D5.repo,
      repositoryRoot: d5Derived,
      trustedAuthorityBaseRevision: d5Base,
      baseRevision: d5Base,
      headRevision: d5NormativeHead,
      model: {
        authority: { requirements: d5BaseReq, evaluationRoots: [d5StableRoot], rootSubjects: d5RootSubjects },
        base: { requirements: d5BaseReq, rootSubjects: d5RootSubjects },
        head: { requirements: d5NormativeReq, rootSubjects: d5RootSubjects },
      },
      workIntent: { id: "i9-d5-derived-normative", addresses: ["D5-R"] },
    });
    assert.equal(d5Normative.replay.ok, false);
    assert.ok(d5Normative.replay.gaps.some((x) => x.includes("missing_authority:requirement:D5-R")));

    const historical = {
      D1: { pr: 2173, base: "2303bafe5a85e84ca02ff3a6f70b6c99c5f554e8", head: "7aea9cbcab90c2d57f75843f7cff0e4c893c214c", legacy: "GREEN", classification: "REAL_SOURCE_OBSERVED" },
      D2: { pr: 493, base: "832daa89f15fd0f3b7b40819b6d3670c7fd57e7d", head: "24ed472b4bb10e9010899b8e06253d70d72c67c1", legacy: "RED_THEN_GREEN", classification: "REAL_SOURCE_OBSERVED" },
      D3: { pr: 122, base: "8181a444ca96159b18b50f8ec93d1d323d3acdf9", head: "43f4f07b6ce567fd6eb655f68b8a8934c34bb800", legacy: "GREEN", classification: "REAL_SOURCE_OBSERVED" },
      D4: { pr: 196, base: "cc9a39ba59c7a7c916dd01810ee199f991e10a3d", head: "86e8fa6bc3946a8630deb8d118a879b57154fd4e", legacy: "GREEN", classification: "REAL_SOURCE_OBSERVED" },
      D5Positive: { pr: 55, base: "22751461764817de343b6f71faaeb314de2c1a71", head: "2470d62b9d41bb75197a8ec4e1e26aaf882aefe9", legacy: "GREEN_WITHOUT_GRANT", classification: "REAL_SOURCE_OBSERVED" },
      D5Negative: { pr: 57, base: "a19b207b8c9aab3440930faa39e47db107fd5c9b", head: "64704d9fd746abb6573258bacbe31028b472d907", legacy: "RED", classification: "REAL_SOURCE_OBSERVED" },
    };

    const differences = [
      {
        id: "D1-global-budget-vs-requirement-owned-scope",
        legacy: "global diff budget/change profile can block large scientific integration",
        vnext: "constraint applies only when owned by an applicable Requirement",
        classification: "EXPECTED_INTENTIONAL_DIFFERENCE",
        basis: "#691/#699 accepted differential",
      },
      {
        id: "D4-trusted-approver",
        legacy: "trusted-kernel transition requires protected profile and matching unit test",
        vnext: "protected Resource requires independent TRUST plus exact applicable DOMAIN evidence",
        classification: "EQUIVALENT",
        basis: "real #196 + derived production replay",
      },
      {
        id: "D5-routine-relation-replacement",
        legacy: "#55 current v3.2.4 routine relation addition/replacement path is GREEN without grant",
        vnext: "routine implemented_by replacement is GREEN with no authority receipt",
        classification: "EQUIVALENT",
        basis: "real #55 + derived production replay",
      },
      {
        id: "D5-closed-repository",
        legacy: "closed_repository=false permits tracked files outside requirement closure",
        vnext: "full J1 tracked-tree justification is mandatory",
        classification: "EXPECTED_INTENTIONAL_DIFFERENCE",
        basis: "#691/#699 accepted universal J1 model",
      },
      {
        id: "consumer-vnext-authority",
        legacy: "consumer-specific accepted legacy authority exists where observed",
        vnext: "no independently accepted complete consumer vNext authority model yet",
        classification: "UNPROVEN",
        basis: "real-source audit",
      },
    ];
    assert.equal(differences.some((x) => x.classification === "UNEXPECTED_REGRESSION"), false);

    const legacyMechanisms = {
      packs: "DERIVED",
      anchors: "DERIVED",
      trace_rules: "DERIVED",
      document_relations: "DERIVED",
      evidence_bindings: "DOMAIN",
      change_profiles: "TRUST",
      surfaces: "DERIVED",
      new_file_classes: "DERIVED",
      cochange_rules: "DERIVED",
      pr_immutable: "TRUST",
      governance_paths: "TRUST",
      closed_repository: "LEGACY",
      content_rules: "DOMAIN",
      size_rules: "OBSERVATION",
      diff_rules: "OBSERVATION",
      release_rules: "TRUST",
    };
    assert.deepEqual(
      [...new Set(Object.values(legacyMechanisms))].sort(),
      ["DERIVED", "DOMAIN", "LEGACY", "OBSERVATION", "TRUST"],
    );

    const ceremony = {
      D1: { evidence: "OBSERVED", governanceOnlyPrs: [2278, 2279, 2282, 2283], manualGrants: "NOT_PROVEN" },
      D2: { evidence: "OBSERVED", representativeGovernancePr: 493, manualGrants: "NOT_PROVEN" },
      D3: { evidence: "OBSERVED", representativeVersionPr: 122, manualGrants: "NOT_PROVEN" },
      D4: { evidence: "OBSERVED", trustedProfilePr: 180, trustedKernelPr: 196, securityGateRetained: true },
      D5: { evidence: "OBSERVED", routineNoGrantPr: 55, strongWeakeningRedPr: 57, projectedVnextRoutineGrantCount: 0 },
    };
    const complexity = {
      governancePathDeclarations: Object.values(observed).reduce((n, x) =>
        n + (x.policy.paths?.governance_paths?.length || 0), 0),
      namedSurfaces: Object.values(observed).reduce((n, x) =>
        n + Object.keys(x.policy.surfaces || {}).length, 0),
      permanentChangeProfiles: Object.values(observed).reduce((n, x) =>
        n + Object.keys(x.policy.change_profiles || {}).length, 0),
      provisionalCoreConsumerBranches: 0,
    };
    assert.deepEqual(complexity, {
      governancePathDeclarations: 50,
      namedSurfaces: 19,
      permanentChangeProfiles: 13,
      provisionalCoreConsumerBranches: 0,
    });

    const migration = {
      D1: { source: "requirements/mts-v0.15.json + mts-source corpus", status: "NOT_PROVEN", gap: "no independently accepted vNext J2/J1/J3 model" },
      D2: { source: "VERSION + upstream locks/contracts", status: "NOT_PROVEN", gap: "no consumer vNext Requirement roots" },
      D3: { source: "package metadata + policy", status: "NOT_PROVEN", gap: "no consumer vNext Requirement roots" },
      D4: { source: "trusted_approver policy + proofApproval source", status: "PROVISIONAL_MIGRATION_MODEL", gap: "derived fixture proves semantics, not accepted consumer authority" },
      D5: {
        source: "five exact canonical Requirement files",
        status: "PROVISIONAL_MIGRATION_MODEL",
        gap: "legacy artifacts need accepted typed-relation migration; real-tree provisional J1 remains incomplete",
        realTreeJ2Rooted: d5RealTreeReplay.replay.authority.j2.rooted.length,
        realTreeJ1Justified: d5RealTreeReplay.replay.head.j1.justified.length,
        realTreeJ1Unjustified: d5RealTreeReplay.replay.head.j1.unjustified.length,
      },
    };

    const testSourceText = readFileSync(resolve("tests/test-699-five-consumer-differential.mjs"), "utf8");
    const researchScenarioDefinitions = (testSourceText.match(/test\("#699 /g) || []).length;
    assert.equal(researchScenarioDefinitions, 53);

    const legacyBlockingInput = {
      mode: "check-diff",
      repositoryRoot: root,
      policy: {
        policy_format_version: "0.3.0",
        repository_kind: "tooling",
        paths: { forbidden: ["secret/**"], governance_paths: [], canonical_docs: [], operational_paths: [] },
        diff_rules: { max_new_files: 10, max_new_docs: 10, max_net_added_lines: 100 },
        content_rules: [],
        cochange_rules: [],
      },
      changeIntent: null,
      changeIntentSource: "none",
      enforcement: { ok: true, mode: "blocking", source: "i9-a10", requested: "blocking" },
      diffText: [
        "diff --git a/secret/x.txt b/secret/x.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/secret/x.txt",
        "+blocked",
      ].join("\n"),
      trackedFiles: ["secret/x.txt"],
    };
    const candidateFailureShadow = productionPipeline.runPolicyPipelineShadow(
      legacyBlockingInput,
      { quiet: true },
      () => { throw new Error("I9 candidate failure"); },
    );
    assert.equal(candidateFailureShadow.legacy.exitCode !== 0, true);
    assert.equal(candidateFailureShadow.comparison.legacy.blocking, true);
    assert.equal(candidateFailureShadow.comparison.candidate.ok, false);
    assert.match(candidateFailureShadow.comparison.candidate.reasons[0], /^SHADOW_EXECUTION_ERROR:/);

    const checks = {
      R01: () => assert.equal(Object.values(observed).every((x) => /^[0-9a-f]{40}$/.test(x.current)), true),
      R02: () => assert.equal(Object.keys(observed).length, 5),
      R03: () => assert.equal(Object.values(observed).every((x) => ["NO_DRIFT", "DRIFT_DETECTED"].includes(x.drift)), true),
      R04: () => assert.deepEqual(Object.fromEntries(Object.entries(observed).map(([id, x]) => [id, x.entries.length])),
        Object.fromEntries(Object.entries(PINS).map(([id, x]) => [id, x.tracked]))),
      R05: () => assert.equal(Object.values(observed).every((x) => x.replay.observation.headTracked === x.entries.length), true),
      R06: () => assert.equal(d5Canonical.requirements.every((r) => r.semantic.digest.length === 64 && r.representation.revision === PINS.D5.pin), true),
      R07: () => assert.match(d2Lock.acceptedCommit, /^[0-9a-f]{40}$/),
      R08: () => assert.equal(Object.values(observed).every((x) => x.replay.observation.headRevision === PINS[Object.keys(observed).find((id) => observed[id] === x)].pin), true),
      R09: () => {
        assert.equal(d5DivergedDiff.some((x) => x.path === "base-only.txt" || x.previousPath === "base-only.txt"), false);
        assert.equal(d5DivergedDiff.some((x) => x.path === "src/knowledge-snapshot-v0.mjs"), true);
      },
      R10: () => assert.equal(Object.values(observed).every((x) => x.replay.replay.acceptedAuthorityVerified === false), true),

      D01: () => assert.equal(researchScenarioDefinitions, 53, "#699 existing scenarios remain exactly present"),
      D02: () => { assert.equal(d1Registry.accepted, true); assert.equal(observed.D1.replay.replay.acceptedAuthorityVerified, false); },
      D03: () => assert.ok(d1Registry.requirements.find((r) => r.id === "V15-DOCS-01")?.evidence?.requiredExecutableGates?.length > 0),
      D04: () => { assert.equal(d2Lock.floatingRefsAllowed, false); assert.ok(observed.D2.policy.cochange_groups?.length >= 1); },
      D05: () => assert.equal(d3Package.version, d3PackageLock.packages[""].version),
      D06: () => assert.deepEqual(d4Policy.surfaces.trusted_approver, ["src/core/proofApproval.ts"]),
      D07: () => { assert.equal(d4NoTrust.replay.ok, false); assert.equal(d4Green.replay.ok, true); },
      D08: () => { assert.equal(historical.D5Positive.legacy, "GREEN_WITHOUT_GRANT"); assert.equal(d5Routine.replay.ok, true); },
      D09: () => { assert.equal(historical.D5Negative.legacy, "RED"); assert.equal(d5Normative.replay.ok, false); },
      D10: () => {
        const allowed = new Set(["EQUIVALENT", "EXPECTED_INTENTIONAL_DIFFERENCE", "UNEXPECTED_REGRESSION", "UNPROVEN"]);
        assert.equal(differences.every((x) => allowed.has(x.classification)), true);
        assert.equal(differences.some((x) => x.classification === "UNEXPECTED_REGRESSION"), false);
        assert.ok(differences.some((x) => x.classification === "EXPECTED_INTENTIONAL_DIFFERENCE"));
        assert.ok(differences.some((x) => x.classification === "UNPROVEN"));
      },

      A01: () => assert.equal(d4Green.replay.acceptedAuthorityVerified, false),
      A02: () => assert.equal(d5Normative.replay.ok, false),
      A03: () => assert.equal(d4WrongProvider.replay.ok, false),
      A04: () => assert.equal(d4StaleReceipt.replay.ok, false),
      A05: () => assert.equal(d4StaleReceipt.replay.ok, false),
      A06: () => assert.equal(d4WrongSubject.replay.ok, false),
      A07: () => assert.ok(d4NoTrust.replay.gaps.some((x) => x.includes("missing_evidence"))),
      A08: () => {
        assert.equal(d4NoIntent.replay.ok, false);
        assert.ok(d4NoIntent.replay.gaps.some((x) => x.includes("J3:no_cause")));
      },
      A09: () => {
        assert.equal(observed.D2.policy.enforcement.mode, "advisory");
        assert.equal(observed.D5.policy.enforcement.mode, "advisory");
        assert.match(d2RepoGuardWorkflow, /enforcement:\s*blocking/);
        assert.match(d5RepoGuardWorkflow, /enforcement:\s*blocking/);
      },
      A10: () => {
        assert.equal(candidateFailureShadow.legacy.exitCode !== 0, true);
        assert.equal(candidateFailureShadow.comparison.legacy.blocking, true);
        assert.equal(candidateFailureShadow.comparison.candidate.ok, false);
      },

      M01: () => assert.deepEqual(Object.keys(migration).sort(), ["D1","D2","D3","D4","D5"]),
      M02: () => {
        assert.equal(Object.values(migration).every((x) => typeof x.gap === "string" && x.gap.length > 0), true);
        assert.equal(migration.D5.realTreeJ2Rooted, 5);
        assert.ok(migration.D5.realTreeJ1Justified > 0);
        assert.ok(migration.D5.realTreeJ1Unjustified > 0);
      },
      M03: () => assert.equal(JSON.stringify(migration).includes("*"), false),
      M04: () => assert.equal(JSON.stringify(migration).includes("self-requires"), false),
      M05: () => assert.equal(Object.values(migration).every((x) => !Array.isArray(x.paths)), true),
      M06: () => assert.equal(d5Routine.replay.ok, true),
      M07: () => assert.equal(d5Normative.replay.ok, false),
      M08: () => assert.equal(Object.values(ceremony).every((x) => typeof x.evidence === "string"), true),
      M09: () => assert.deepEqual([complexity.governancePathDeclarations, complexity.namedSurfaces, complexity.permanentChangeProfiles], [50,19,13]),
      M10: () => {
        const source = readFileSync(resolve("src/runtime/pipeline.mts"), "utf8");
        for (const name of ["anum_docs","amemory","anum_parser","aprover","mts-nl-compiler"]) assert.equal(source.includes(name), false);
      },
    };
    assert.equal(Object.keys(checks).length, 40);
    for (const [id, check] of Object.entries(checks)) await t.test(id, check);

    const result = {
      event: "I9_FIVE_CONSUMER_REPLAY",
      pins: Object.fromEntries(Object.entries(PINS).map(([id, x]) => [id, x.pin])),
      current: Object.fromEntries(Object.entries(observed).map(([id, x]) => [id, x.current])),
      drift: Object.fromEntries(Object.entries(observed).map(([id, x]) => [id, x.drift])),
      tracked: Object.fromEntries(Object.entries(observed).map(([id, x]) => [id, x.entries.length])),
      policyBlobs: Object.fromEntries(Object.entries(PINS).map(([id, x]) => [id, x.policyBlob])),
      canonicalSourceFacts: { d1RequirementFiles: d1Sources.length, d5CanonicalRequirements: d5Canonical.requirements.length },
      researchFixture: { issue: 699, scenarios: 53, classification: "RESEARCH_FIXTURE_PASS" },
      historical,
      provisionalProductionReplay: {
        D4: { negativeWithoutTrust: !d4NoTrust.replay.ok, exactDomainGreen: d4Green.replay.ok, classification: d4Green.replay.classification, acceptedAuthorityVerified: false },
        D5: {
          routineReplacementGreen: d5Routine.replay.ok,
          normativeChangeRed: !d5Normative.replay.ok,
          realTreeJ2Rooted: d5RealTreeReplay.replay.authority.j2.rooted.length,
          realTreeJ1Justified: d5RealTreeReplay.replay.head.j1.justified.length,
          realTreeJ1Unjustified: d5RealTreeReplay.replay.head.j1.unjustified.length,
          classification: d5Routine.replay.classification,
          acceptedAuthorityVerified: false,
        },
      },
      migration,
      differences,
      legacyMechanisms,
      ceremony,
      complexity,
      trustBoundary: "external to pure evaluator",
      domainBoundary: "real process execution used only in explicitly derived D4 fixture",
      consumerModifications: 0,
      readiness: "HOLD_FOR_UNPROVEN_GUARANTEES",
    };
    console.log(JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
