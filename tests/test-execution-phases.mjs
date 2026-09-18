import { createRuleRegistry } from "../dist/checks/rule-registry.mjs";
import { defaultRuleFamilies } from "../dist/checks/default-rule-families.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";
import { runPolicyPipeline } from "../dist/runtime/pipeline.mjs";

let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${expected}, got: ${actual}`);
  }
}

function names(entries) {
  return entries.map((entry) => entry.name).join(",");
}

function hasName(entries, expected) {
  return entries.some((entry) => entry.name === expected);
}

function namedCheck(entries, expected) {
  return entries.find((entry) => entry.name === expected)?.check;
}

function familyPhase(id) {
  return defaultRuleFamilies.find((family) => family.id === id)?.phase;
}

const registry = createRuleRegistry();
registry.register({
  id: "transaction-family",
  phase: "transaction",
  evaluate: () => ({ name: "transaction-check", check: { ok: true } }),
});
registry.register({
  id: "state-family",
  phase: "state",
  evaluate: () => ({ name: "state-check", check: { ok: true } }),
});
registry.register({
  id: "both-family",
  phase: "both",
  evaluate: () => ({ name: "both-check", check: { ok: true } }),
});

expect(
  "legacy/default evaluation still executes every classified family",
  names(registry.evaluate({})),
  "transaction-check,state-check,both-check"
);
expect(
  "transaction phase executes transaction and both families only",
  names(registry.evaluate({}, { executionPhase: "transaction" })),
  "transaction-check,both-check"
);
expect(
  "state phase executes state and both families only",
  names(registry.evaluate({}, { executionPhase: "state" })),
  "state-check,both-check"
);
expect(
  "explicit both phase preserves legacy execution",
  names(registry.evaluate({}, { executionPhase: "both" })),
  "transaction-check,state-check,both-check"
);

let missingPhaseError = "";
try {
  createRuleRegistry().register({
    id: "unclassified-family",
    evaluate: () => ({ name: "unclassified-check", check: { ok: true } }),
  });
} catch (error) {
  missingPhaseError = error.message;
}
expect(
  "new rule family without phase classification fails closed",
  missingPhaseError.includes("phase"),
  true
);

let unknownPhaseError = "";
try {
  createRuleRegistry().register({
    id: "unknown-phase-family",
    phase: "future-phase",
    evaluate: () => ({ name: "unknown-phase-check", check: { ok: true } }),
  });
} catch (error) {
  unknownPhaseError = error.message;
}
expect(
  "unknown rule family phase fails closed",
  unknownPhaseError.includes("phase"),
  true
);
expect("governance authorization remains transaction-only", familyPhase("governance-paths"), "transaction");
expect("policy relaxation authorization remains transaction-only", familyPhase("policy-delta"), "transaction");

const constraintFacts = {
  repositoryRoot: process.cwd(),
  trackedFiles: ["src/new.mjs"],
  policy: {
    paths: {
      forbidden: ["secrets/**"],
      canonical_docs: [],
      operational_paths: [],
    },
    diff_rules: {
      max_new_files: 0,
    },
  },
  changeIntent: null,
  diff: {
    files: {
      checked: [
        {
          path: "src/new.mjs",
          status: "added",
          addedLines: ["export const value = 1;"],
          deletedLines: [],
        },
      ],
    },
  },
};

const legacyConstraints = evaluateConstraintIR(constraintFacts);
const explicitBothConstraints = evaluateConstraintIR(constraintFacts, { executionPhase: "both" });
const transactionConstraints = evaluateConstraintIR(constraintFacts, { executionPhase: "transaction" });
const stateConstraints = evaluateConstraintIR(constraintFacts, { executionPhase: "state" });

expect(
  "explicit both keeps constraint evaluation byte-order compatible with legacy",
  names(explicitBothConstraints),
  names(legacyConstraints)
);
expect("transaction constraints keep diff budget", hasName(transactionConstraints, "max-new-files"), true);
expect("state constraints exclude diff budget", hasName(stateConstraints, "max-new-files"), false);

const sizeFacts = {
  repositoryRoot: process.cwd(),
  trackedFiles: ["src/existing.mjs", "src/new.mjs"],
  readFile: (path) => ({
    "src/existing.mjs": "export const existing = 1;\n",
    "src/new.mjs": "export const value = 1;\n",
  })[path],
  policy: {
    paths: {
      forbidden: [],
      canonical_docs: [],
      operational_paths: [],
    },
    size_rules: [
      {
        id: "state-absolute",
        scope: "directory",
        metric: "files",
        glob: "src/**",
        max: 1,
      },
      {
        id: "transaction-changed",
        scope: "file",
        metric: "lines",
        glob: "src/new.mjs",
        max: 0,
        count: "changed_only",
      },
      {
        id: "mixed-growth",
        scope: "directory",
        metric: "files",
        glob: "src/**",
        max: 2,
        max_growth: 0,
      },
    ],
  },
  changeIntent: null,
  diff: {
    files: {
      checked: [
        {
          path: "src/new.mjs",
          status: "added",
          addedLines: ["export const value = 1;"],
          deletedLines: [],
        },
      ],
    },
  },
};

const stateSize = evaluateConstraintIR(sizeFacts, { executionPhase: "state" });
const transactionSize = evaluateConstraintIR(sizeFacts, { executionPhase: "transaction" });

expect("state phase executes absolute repository invariant", namedCheck(stateSize, "size:state-absolute:max")?.ok, false);
expect("state phase excludes changed-only invariant", hasName(stateSize, "size:transaction-changed:max"), false);
expect("state phase executes absolute facet of mixed invariant", namedCheck(stateSize, "size:mixed-growth:max")?.ok, true);
expect("state phase excludes growth facet of mixed invariant", hasName(stateSize, "size:mixed-growth:max-growth"), false);
expect("transaction phase excludes pure absolute repository invariant", hasName(transactionSize, "size:state-absolute:max"), false);
expect("transaction phase executes changed-only invariant", namedCheck(transactionSize, "size:transaction-changed:max")?.ok, false);
expect("transaction phase excludes absolute facet of mixed invariant", hasName(transactionSize, "size:mixed-growth:max"), false);
expect("transaction phase executes growth facet of mixed invariant", namedCheck(transactionSize, "size:mixed-growth:max-growth")?.ok, false);

const pipelineInput = {
  mode: "check-diff",
  repositoryRoot: "/tmp/repo-guard-phase-pipeline",
  policy: {
    policy_format_version: "0.3.0",
    repository_kind: "tooling",
    paths: {
      forbidden: [],
      canonical_docs: [],
      operational_paths: [],
      governance_paths: [],
    },
    diff_rules: { max_new_files: 0 },
    size_rules: [
      {
        id: "pipeline-state-absolute",
        scope: "directory",
        metric: "files",
        glob: "src/**",
        max: 1,
      },
    ],
    content_rules: [],
    cochange_rules: [],
  },
  changeIntent: null,
  changeIntentSource: "none",
  enforcement: { ok: true, mode: "blocking", source: "test", requested: "blocking" },
  diffText: [
    "diff --git a/src/new.mjs b/src/new.mjs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.mjs",
    "+export const value = 1;",
  ].join("\n"),
  trackedFiles: ["src/new.mjs"],
  readFile: () => undefined,
};

const legacyPipeline = runPolicyPipeline(pipelineInput, { quiet: true });
const statePipeline = runPolicyPipeline(pipelineInput, { quiet: true, executionPhase: "state" });
const transactionPipeline = runPolicyPipeline(pipelineInput, { quiet: true, executionPhase: "transaction" });
const legacyPipelineRules = legacyPipeline.ruleResults.map((entry) => entry.rule);
const statePipelineRules = statePipeline.ruleResults.map((entry) => entry.rule);
const transactionPipelineRules = transactionPipeline.ruleResults.map((entry) => entry.rule);

expect("legacy pipeline report keeps old machine shape", Object.prototype.hasOwnProperty.call(legacyPipeline, "executionPhase"), false);
expect("state pipeline reports explicit execution phase", statePipeline.executionPhase, "state");
expect("transaction pipeline reports explicit execution phase", transactionPipeline.executionPhase, "transaction");
expect("legacy pipeline still executes transaction rule", legacyPipelineRules.includes("max-new-files"), true);
expect("legacy pipeline still executes state size primitive", legacyPipelineRules.includes("size:pipeline-state-absolute:max"), true);
expect("state pipeline excludes transaction rule", statePipelineRules.includes("max-new-files"), false);
expect("state pipeline executes state size primitive without ChangeIntent", statePipelineRules.includes("size:pipeline-state-absolute:max"), true);
expect("transaction pipeline executes transaction rule", transactionPipelineRules.includes("max-new-files"), true);
expect("transaction pipeline excludes state-only size primitive", transactionPipelineRules.includes("size:pipeline-state-absolute:max"), false);

console.log(`\n${failures === 0 ? "All execution phase tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
