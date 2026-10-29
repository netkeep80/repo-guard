import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const yaml = (path) => {
  const doc = parseDocument(read(path));
  assert.deepEqual(doc.errors, [], `${path}: invalid YAML`);
  return doc.toJS();
};

const ci = yaml(".github/workflows/ci.yml");
assert.deepEqual(Object.keys(ci.jobs ?? {}).sort(), ["smoke-pack", "validate"]);
assert.deepEqual(ci.permissions, { contents: "read" });
assert.deepEqual([...(ci.on?.pull_request?.types ?? [])].sort(), ["edited", "opened", "ready_for_review", "reopened", "synchronize"]);

const validate = ci.jobs.validate;
const names = (validate.steps ?? []).map((step) => step.name).filter(Boolean);
for (const name of [
  "Acquire minimal Git evidence",
  "Verify generated dist freshness",
  "Verify real local documentation projections",
  "Run compiler-only self-host witness",
  "Run discovered test suite",
]) assert.ok(names.includes(name), `missing CI step ${name}`);
for (const retired of [
  "Validate repo-policy.json",
  "Run doctor diagnostics on self",
  "Exercise advisory policy mode",
  "Report architecture compression metrics",
]) assert.equal(names.includes(retired), false, `retired CI step remains: ${retired}`);

const workflowText = read(".github/workflows/ci.yml");
for (const token of ["repo-policy.json", "check-diff", "--enforcement", "doctor"]) {
  assert.equal(workflowText.includes(token), false, `CI still exposes legacy token ${token}`);
}

const smoke = ci.jobs["smoke-pack"].steps.find((step) => step.name === "Smoke-test packaged artifact");
assert.ok(smoke);
assert.match(smoke.run, /repo-guard.*check/s);
assert.match(smoke.run, /--base/);
assert.match(smoke.run, /--head/);

const gate = yaml(".github/workflows/compiler-gate.yml");
const gateSteps = gate.jobs?.["compiler-gate"]?.steps ?? [];
assert.ok(gateSteps.some((step) => step.with?.ref === "${{ github.event.pull_request.base.sha }}"));
assert.ok(gateSteps.some((step) => /node dist\/repo-guard\.mjs check/.test(step.run ?? "")));

console.log("Current compiler-only CI contract passed");


const concurrency = ci.concurrency;
assert.equal(concurrency?.["cancel-in-progress"], true, "CI must keep cancel-in-progress enabled");

function concurrencyGroup(event) {
  const template = concurrency?.group;
  assert.equal(typeof template, "string", "CI concurrency.group must be a string");
  const lookup = (path) => {
    const parts = path.trim().split(".");
    assert.equal(parts.shift(), "github", "unsupported concurrency expression root");
    let value = event;
    for (const part of parts) value = value?.[part];
    return value;
  };
  const evaluate = (expression) => {
    const terms = expression.split("||").map((term) => term.trim());
    for (const term of terms) {
      const value = lookup(term);
      if (value !== undefined && value !== null && value !== "") return String(value);
    }
    return "";
  };
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression) => evaluate(expression));
}

const pr = ({ number, headRef, owner, runId, headSha = "a".repeat(40) }) => ({
  event_name: "pull_request",
  head_ref: headRef,
  run_id: runId,
  ref: `refs/pull/${number}/merge`,
  event: {
    pull_request: {
      number,
      head: {
        ref: headRef,
        sha: headSha,
        repo: { full_name: `${owner}/repo-guard` },
      },
    },
  },
});
const push = ({ runId, sha }) => ({
  event_name: "push",
  head_ref: "",
  run_id: runId,
  ref: "refs/heads/main",
  sha,
  event: {},
});

const pr100a = pr({ number: 100, headRef: "patch-1", owner: "fork-A", runId: 1001, headSha: "a".repeat(40) });
const pr100b = pr({ number: 100, headRef: "patch-1", owner: "fork-A", runId: 1002, headSha: "b".repeat(40) });
const pr100Renamed = pr({ number: 100, headRef: "renamed", owner: "fork-Z", runId: 1003, headSha: "c".repeat(40) });
const pr101SameBranch = pr({ number: 101, headRef: "patch-1", owner: "fork-B", runId: 1011 });
const pr102OtherBranch = pr({ number: 102, headRef: "topic-2", owner: "fork-C", runId: 1021 });
const mainA = push({ runId: 2001, sha: "d".repeat(40) });
const mainB = push({ runId: 2002, sha: "e".repeat(40) });

assert.equal(
  concurrencyGroup(pr100a),
  concurrencyGroup(pr100b),
  "same PR must keep one concurrency group across newer commits",
);
assert.notEqual(
  concurrencyGroup(pr100a),
  concurrencyGroup(pr101SameBranch),
  "different PRs with identical head_ref must not share CI concurrency group",
);
assert.equal(
  concurrencyGroup(pr100a),
  concurrencyGroup(pr100Renamed),
  "PR concurrency identity must not depend on fork owner or source branch label",
);
assert.notEqual(
  concurrencyGroup(pr100a),
  concurrencyGroup(pr102OtherBranch),
  "different PRs must have different CI concurrency groups",
);
assert.equal(
  concurrencyGroup(mainA),
  concurrencyGroup(mainB),
  "successive main pushes must share a cancellation group",
);
assert.notEqual(
  concurrencyGroup(pr100a),
  concurrencyGroup(mainA),
  "pull_request CI must not share a concurrency group with main push CI",
);

console.log("#837 CI concurrency behavior matrix passed");
