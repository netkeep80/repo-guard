import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  COMMANDS,
  reconcileAuthorityTarget,
  runBoundedChild,
  runCli,
  sameAuthorityEvaluationKey,
  verifyAuthorityWebhook,
} from "../dist/repo-guard.mjs";

// #810 negative control: accepted baseline must fail while trusted-service is public.
assert.equal(COMMANDS.includes("trusted-service"), false, "4.0 CLI must not publish trusted-service");

assert.deepEqual(
  [...COMMANDS].sort(),
  ["validate", "check-diff", "check-pr", "check", "build", "trusted-service", "init", "doctor"].sort(),
);

const originalError = console.error, errors = [];
console.error = (...args) => errors.push(args.join(" "));
const cases = [
  [["--definitely-unknown"], /Unknown option/],
  [["--repo-root"], /--repo-root requires a path argument/],
  [["check-diff", "--base"], /--base requires a value/],
  [["check-diff", "--change-intent"], /--change-intent requires a value/],
  [["check-diff", "--contract", "legacy.json"], /Unknown option for check-diff/],
  [["check-pr", "extra"], /Unexpected argument for check-pr/],
  [["trusted-service", "--bogus"], /Unknown option for trusted-service/],
  [["trusted-service", "extra"], /Unexpected argument for trusted-service/],
  [["validate", "one.json", "two.json"], /Unexpected argument for validate/],
  [["init", "--bogus"], /Unknown option for init/],
];
try {
  for (const [args, pattern] of cases) {
    errors.length = 0;
    assert.equal(await runCli(args), 1);
    assert.match(errors.join("\n"), pattern);
  }
} finally {
  console.error = originalError;
}

const trustedServiceSource = readFileSync(new URL("../src/repo-guard.mts", import.meta.url), "utf8");
assert.doesNotMatch(
  trustedServiceSource,
  /function discoverAuthorityTargets/,
  "bounded recovery must not periodically enumerate every App installation/repository",
);
assert.match(
  trustedServiceSource,
  /for \(const target of state\.list\(\)\) enqueue\(target\)/,
  "periodic recovery must revisit only durable known PR targets",
);
assert.match(
  trustedServiceSource,
  /repositoryTargets\(config, installationId, repositoryId, repository, linkedIssue\)/,
  "issue refresh must remain repository/linked-issue scoped",
);
assert.doesNotMatch(
  trustedServiceSource,
  /spawnSync\(/,
  "trusted-service evaluator must not synchronously block the webhook event loop",
);
assert.match(
  trustedServiceSource,
  /timeout: SERVICE_GIT_TIMEOUT_MS/,
  "synchronous Git operations in trusted-service must have a hard deadline",
);

const sha = (char) => char.repeat(40);
const target = { installationId: 11, repositoryId: 22, repository: "example/consumer", pr: 7 };
const key = (overrides = {}) => ({
  installationId: 11,
  repositoryId: 22,
  repository: "example/consumer",
  pr: 7,
  authorityBase: sha("a"),
  base: sha("a"),
  head: sha("b"),
  evaluator: sha("c"),
  authorityDigest: sha("d"),
  ...overrides,
});
const carrier = sha("f");
const observation = (value, merge = carrier, active = true) => ({ active, key: value, merge });
const keyId = (value) => [value.installationId, value.repositoryId, value.pr].join(":");
const inMemoryDeps = ({ observed, evaluation = "success", publications = [], evaluations = [] }) => {
  const records = new Map();
  let observationIndex = 0;
  return {
    records,
    deps: {
      observe: async () => {
        const value = observed[Math.min(observationIndex, observed.length - 1)];
        observationIndex += 1;
        return value?.key ? value : observation(value);
      },
      publish: async (_target, value, state) => publications.push([value, state]),
      evaluate: async (_target, value, merge) => {
        evaluations.push({ key: value, merge });
        if (evaluation instanceof Error) throw evaluation;
        return typeof evaluation === "function" ? evaluation(value, merge) : evaluation;
      },
      get: (current) => records.get([current.installationId, current.repositoryId, current.pr].join(":")) ?? null,
      put: (record) => records.set(keyId(record.key), record),
      remove: (current) => records.delete([current.installationId, current.repositoryId, current.pr].join(":")),
    },
  };
};

{
  const body = Buffer.from('{"repository":"example/consumer"}');
  const secret = "webhook-secret";
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyAuthorityWebhook(secret, body, signature), true);
  assert.equal(verifyAuthorityWebhook(secret, body, signature.slice(0, -1) + "0"), false);
}

{
  assert.equal(sameAuthorityEvaluationKey(key(), key()), true);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ pr: 99 })), true,
    "PR number is routing metadata, not transition identity");
  assert.equal(sameAuthorityEvaluationKey(key(), key({ repositoryId: 23 })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ authorityBase: sha("e") })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ base: sha("e") })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ head: sha("e") })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ evaluator: sha("e") })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ authorityDigest: sha("e") })), false);
}

{
  const publications = [], evaluations = [];
  const fixture = inMemoryDeps({ observed: [key(), key(), key()], publications, evaluations });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications, [
    [key().head, "pending"],
    [carrier, "pending"],
    [carrier, "success"],
  ]);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].merge, carrier);
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "skipped");
  assert.equal(publications.length, 3, "duplicate current transition must be idempotent");
  assert.ok(publications.filter(([value, state]) => value === key().head && state !== "pending").length === 0,
    "HEAD is a permanent fail-closed sentinel and never receives a terminal result");
}

{
  const publications = [], evaluations = [];
  const oldKey = key(), newKey = key({ authorityDigest: sha("e") });
  const fixture = inMemoryDeps({
    observed: [oldKey, oldKey, newKey, newKey],
    publications,
    evaluations,
  });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications.slice(-2), [[carrier, "pending"], [carrier, "success"]],
    "authorityDigest change must invalidate the current carrier before fresh terminal GREEN");
  assert.equal(evaluations.at(-1).key.authorityDigest, sha("e"));
}

{
  const publications = [];
  const oldKey = key(), newKey = key({ evaluator: sha("e") });
  const fixture = inMemoryDeps({ observed: [oldKey, oldKey, newKey, newKey], publications });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications.slice(-2), [[carrier, "pending"], [carrier, "success"]],
    "evaluator change must invalidate the current carrier before fresh terminal GREEN");
}

{
  const publications = [];
  const oldKey = key(), newKey = key({ authorityBase: sha("e"), base: sha("e") });
  const newCarrier = sha("a");
  const fixture = inMemoryDeps({
    observed: [observation(oldKey), observation(oldKey), observation(newKey, newCarrier), observation(newKey, newCarrier)],
    publications,
  });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications.slice(-2), [[newCarrier, "pending"], [newCarrier, "success"]],
    "same HEAD with a different BASE must use a fresh transition carrier");
  assert.equal(publications.filter(([value, state]) => value === oldKey.head && state !== "pending").length, 0);
}

{
  const publications = [];
  const oldKey = key(), newKey = key({ head: sha("e") });
  const newCarrier = sha("a");
  const fixture = inMemoryDeps({
    observed: [observation(oldKey), observation(oldKey), observation(newKey, newCarrier), observation(newKey, newCarrier)],
    publications,
  });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications.slice(-3), [
    [newKey.head, "pending"],
    [newCarrier, "pending"],
    [newCarrier, "success"],
  ], "different HEAD must get a new pending sentinel and a fresh transition carrier");
}

{
  const publications = [], evaluations = [];
  const regeneratedCarrier = sha("a");
  const fixture = inMemoryDeps({
    observed: [observation(key()), observation(key()), observation(key(), regeneratedCarrier), observation(key(), regeneratedCarrier)],
    publications,
    evaluations,
  });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications.slice(-2), [[regeneratedCarrier, "pending"], [regeneratedCarrier, "success"]],
    "regenerated test-merge carrier must receive a fresh verdict even for the same semantic transition");
  assert.equal(evaluations.length, 2);
}

{
  const publications = [], evaluations = [];
  const fixture = inMemoryDeps({ observed: [observation(key(), null)], publications, evaluations });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "pending");
  assert.deepEqual(publications, [[key().head, "pending"]],
    "missing test-merge ref must fall back only to the pending HEAD sentinel");
  assert.equal(evaluations.length, 0);
}

{
  const publications = [];
  const fixture = inMemoryDeps({ observed: [key()], publications, evaluation: new Error("dependency failed") });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "pending");
  assert.deepEqual(publications, [[key().head, "pending"], [carrier, "pending"]],
    "service/evaluator failure must leave both fallback and current carrier fail-closed");
}

{
  const publications = [];
  const fixture = inMemoryDeps({ observed: [key(), key(), key()], publications, evaluation: "failure" });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "failure");
  assert.deepEqual(publications, [[key().head, "pending"], [carrier, "pending"], [carrier, "failure"]]);
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "skipped");
}

{
  const publications = [];
  const records = new Map();
  const deps = {
    observe: async (current) => observation(key({
      repositoryId: current.repositoryId,
      repository: current.repository,
      pr: current.pr,
    })),
    publish: async (current, value, state) => publications.push([current.repository, value, state]),
    evaluate: async () => "success",
    get: (current) => records.get([current.installationId, current.repositoryId, current.pr].join(":")) ?? null,
    put: (record) => records.set(keyId(record.key), record),
    remove: (current) => records.delete([current.installationId, current.repositoryId, current.pr].join(":")),
  };
  const second = { installationId: 11, repositoryId: 23, repository: "example/other", pr: 9 };
  assert.equal(await reconcileAuthorityTarget(target, deps), "success");
  assert.equal(await reconcileAuthorityTarget(second, deps), "success");
  assert.equal(records.size, 2, "one service runtime must keep independent state for multiple repositories");
  assert.equal(publications.filter(([repository,, state]) => repository === "example/consumer" && state === "success").length, 1);
  assert.equal(publications.filter(([repository,, state]) => repository === "example/other" && state === "success").length, 1);
}

{
  const publications = [], records = new Map();
  let phase = "active";
  const deps = {
    observe: async () => observation(key(), carrier, phase === "active"),
    publish: async (_target, value, state) => publications.push([value, state]),
    evaluate: async () => "success",
    get: (current) => records.get([current.installationId, current.repositoryId, current.pr].join(":")) ?? null,
    put: (record) => records.set(keyId(record.key), record),
    remove: () => assert.fail("inactive PR must remain durably known"),
  };
  assert.equal(await reconcileAuthorityTarget(target, deps), "success");
  phase = "inactive";
  assert.equal(await reconcileAuthorityTarget(target, deps), "inactive");
  assert.deepEqual(publications.slice(-1), [[carrier, "pending"]],
    "closing/drafting a previously GREEN transition must invalidate its carrier");
  assert.equal(records.get(keyId(key())).state, "pending");

  phase = "active";
  assert.equal(await reconcileAuthorityTarget(target, deps), "success",
    "periodic recovery must reevaluate a reopened PR even if its reopen webhook was lost");
  assert.deepEqual(publications.slice(-1), [[carrier, "success"]]);
}

assert.doesNotMatch(
  trustedServiceSource,
  /deps\.publish\(target,\s*(?:before|after)\.key\.head,\s*result\)/,
  "terminal verdicts must never be published to HEAD",
);
assert.match(
  trustedServiceSource,
  /deps\.publish\(target, before\.merge, result\)/,
  "terminal verdict must be published to the verified current test-merge carrier",
);

{
  const started = Date.now();
  const stalled = runBoundedChild(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10_000)"],
    { cwd: process.cwd(), env: { ...process.env } },
    150,
  );
  const fast = runBoundedChild(
    process.execPath,
    ["-e", "process.stdout.write('fast')"],
    { cwd: process.cwd(), env: { ...process.env } },
    2_000,
  );
  const [stalledResult, fastResult] = await Promise.allSettled([stalled, fast]);
  assert.equal(fastResult.status, "fulfilled");
  assert.equal(fastResult.value.stdout, "fast");
  assert.equal(stalledResult.status, "rejected");
  assert.match(String(stalledResult.reason?.message ?? stalledResult.reason), /timed out/);
  assert.ok(Date.now() - started < 2_000,
    "one stalled evaluator child must not indefinitely block another target");
}

console.log("Declarative CLI and V3 D0-A authority-service contracts passed.");
