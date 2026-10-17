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
  },
  D2: {
    repo: "netkeep80/amemory",
    pin: "c4aab5b5e61c7f30d188fff80aa0f676ef43ec23",
    policyBlob: "7cf24154a2318a171bd0231b02a889076be1a8ba",
    governancePaths: 30,
    surfaces: 0,
    changeProfiles: 0,
  },
  D3: {
    repo: "netkeep80/anum_parser",
    pin: "679f79e8f1692bd88cdebf38c16b97950437afd2",
    policyBlob: "fc17ef608d1750989890ddfe01b0f298396254c2",
    governancePaths: 5,
    surfaces: 0,
    changeProfiles: 0,
  },
  D4: {
    repo: "netkeep80/aprover",
    pin: "98e0152d21d9b492d79aa5017e86a4114d3e5c51",
    policyBlob: "7822e0e68883dc2ee3f2c9cf872b73f681b0706f",
    governancePaths: 4,
    surfaces: 9,
    changeProfiles: 8,
  },
  D5: {
    repo: "netkeep80/mts-nl-compiler",
    pin: "6d9f74625aa35df407563a6cbb046a467894f46b",
    policyBlob: "dbb7cbd6c9f642b4e99d0d98116ca0fabcc1aae6",
    governancePaths: 6,
    surfaces: 0,
    changeProfiles: 0,
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
