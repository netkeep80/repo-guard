import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve(".");
const workflowSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const actionSource = readFileSync(resolve(root, "action.yml"), "utf8");
const document = parseDocument(workflowSource);
assert.equal(document.errors.length, 0);
const workflow = document.toJS();

const validate = workflow.jobs?.validate;
const smokePack = workflow.jobs?.["smoke-pack"];
assert.ok(validate);
assert.ok(smokePack);

const selfCheck = validate.steps.find((step) => step.name === "Run PR policy check");
assert.ok(selfCheck);
assert.equal(selfCheck.uses, undefined, "self enforcement must not recurse through the composite Action");
assert.equal(
  selfCheck.run,
  "node dist/repo-guard.mjs --enforcement blocking check-pr --format json",
  "self enforcement must execute the exact checked-out candidate CLI directly",
);
assert.equal(selfCheck.if, "github.event_name == 'pull_request' && !github.event.pull_request.draft");
assert.equal(selfCheck.env?.GH_TOKEN, "${{ secrets.GITHUB_TOKEN }}");

const validateNodeSetups = validate.steps.filter(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"),
);
assert.equal(validateNodeSetups.length, 1, "validate must prepare Node exactly once");
assert.equal(validate.steps.filter((step) => step.run === "npm ci").length, 1, "validate must install dependencies exactly once");

const distStep = validate.steps.find((step) => step.name === "Verify generated dist freshness");
assert.equal(distStep?.run, "npm run check:dist", "generated dist freshness must remain independently blocking");

const smokeNodeSetups = smokePack.steps.filter(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"),
);
assert.equal(smokeNodeSetups.length, 1, "independent packaged-consumer smoke must retain its Node bootstrap");
const smoke = smokePack.steps.find((step) => step.name === "Smoke-test packaged artifact");
assert.match(smoke?.run ?? "", /npm pack --ignore-scripts/);
assert.match(smoke?.run ?? "", /npm install --prefix/);
assert.match(smoke?.run ?? "", /node_modules\/\.bin\/repo-guard/);

assert.match(actionSource, /name: Set up Node\.js/);
assert.match(actionSource, /name: Install repo-guard dependencies/);
assert.match(actionSource, /npm install --omit=dev --silent/);

const jobSources = JSON.stringify({ validate, smokePack });
assert.doesNotMatch(jobSources, /actions\/(?:upload|download)-artifact@/, "jobs must not share PR-produced artifacts");
