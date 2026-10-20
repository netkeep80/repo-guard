import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  COMMANDS,
  reconcileAuthorityTarget,
  runCli,
  sameAuthorityEvaluationKey,
  verifyAuthorityWebhook,
} from "../dist/repo-guard.mjs";

assert.deepEqual(
  [...COMMANDS].sort(),
  ["validate", "check-diff", "check-pr", "trusted-service", "init", "doctor"].sort(),
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
        return { active: true, key: value };
      },
      publish: async (_target, _head, state) => publications.push(state),
      evaluate: async (_target, value) => {
        evaluations.push(value);
        if (evaluation instanceof Error) throw evaluation;
        return typeof evaluation === "function" ? evaluation(value) : evaluation;
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
  assert.equal(sameAuthorityEvaluationKey(key(), key({ authorityDigest: sha("e") })), false);
  assert.equal(sameAuthorityEvaluationKey(key(), key({ authorityBase: sha("f") })), false);
}

{
  const publications = [], evaluations = [];
  const fixture = inMemoryDeps({ observed: [key(), key(), key()], publications, evaluations });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications, ["pending", "success"]);
  assert.equal(evaluations.length, 1);
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "skipped");
  assert.deepEqual(publications, ["pending", "success"], "duplicate current-key delivery must be idempotent");
  assert.equal(evaluations.length, 1);
}

{
  const publications = [], evaluations = [];
  const oldKey = key(), newKey = key({ authorityDigest: sha("e") });
  const fixture = inMemoryDeps({ observed: [oldKey, newKey, newKey, newKey], publications, evaluations });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "success");
  assert.deepEqual(publications, ["pending", "pending", "success"],
    "same-HEAD authority mutation must invalidate before the fresh terminal verdict");
  assert.equal(evaluations.length, 2);
  assert.equal(evaluations[0].authorityDigest, sha("d"));
  assert.equal(evaluations[1].authorityDigest, sha("e"));
}

{
  const publications = [];
  const fixture = inMemoryDeps({ observed: [key()], publications, evaluation: new Error("dependency failed") });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "pending");
  assert.deepEqual(publications, ["pending"], "service/evaluator failure must never produce terminal GREEN");
}

{
  const publications = [];
  const fixture = inMemoryDeps({ observed: [key(), key(), key()], publications, evaluation: "failure" });
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "failure");
  assert.deepEqual(publications, ["pending", "failure"]);
  assert.equal(await reconcileAuthorityTarget(target, fixture.deps), "skipped");
}

{
  const publications = [];
  const records = new Map();
  const deps = {
    observe: async (current) => ({ active: true, key: key({
      repositoryId: current.repositoryId,
      repository: current.repository,
      pr: current.pr,
    }) }),
    publish: async (current, _head, state) => publications.push([current.repository, state]),
    evaluate: async () => "success",
    get: (current) => records.get([current.installationId, current.repositoryId, current.pr].join(":")) ?? null,
    put: (record) => records.set(keyId(record.key), record),
    remove: (current) => records.delete([current.installationId, current.repositoryId, current.pr].join(":")),
  };
  const second = { installationId: 11, repositoryId: 23, repository: "example/other", pr: 9 };
  assert.equal(await reconcileAuthorityTarget(target, deps), "success");
  assert.equal(await reconcileAuthorityTarget(second, deps), "success");
  assert.deepEqual(publications.map((entry) => entry[1]), ["pending", "success", "pending", "success"]);
  assert.equal(records.size, 2, "one service runtime must keep independent state for multiple repositories");
}

console.log("Declarative CLI and V3 D0-A authority-service contracts passed.");
