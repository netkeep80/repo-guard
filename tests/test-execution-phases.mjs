import { createRuleRegistry } from "../dist/checks/rule-registry.mjs";
import { evaluateConstraintIR } from "../dist/checks/rules/constraints.mjs";

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

const documentContent = new Map([
  ["left.json", JSON.stringify({ items: ["src/a.mjs"] })],
  ["right.json", JSON.stringify({ items: ["src/a.mjs"] })],
]);
const constraintFacts = {
  repositoryRoot: process.cwd(),
  trackedFiles: [...documentContent.keys(), "src/new.mjs"],
  readFile: (path) => documentContent.get(path),
  policy: {
    paths: {
      forbidden: ["secrets/**"],
      canonical_docs: [],
      operational_paths: [],
    },
    diff_rules: {
      max_new_files: 0,
    },
    registry_rules: [
      {
        id: "state-registry",
        kind: "equal",
        left: { type: "json_array", file: "left.json", json_pointer: "/items" },
        right: { type: "json_array", file: "right.json", json_pointer: "/items" },
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
expect("transaction constraints keep surface debt", hasName(transactionConstraints, "surface-debt"), true);
expect("transaction constraints exclude registry state rule", hasName(transactionConstraints, "registry-rules"), false);
expect("state constraints keep registry state rule", hasName(stateConstraints, "registry-rules"), true);
expect("state constraints exclude diff budget", hasName(stateConstraints, "max-new-files"), false);
expect("state constraints exclude surface debt", hasName(stateConstraints, "surface-debt"), false);
expect("state constraints exclude cochange transaction summary", hasName(stateConstraints, "cochange-rules"), false);

const sizeFacts = {
  repositoryRoot: process.cwd(),
  trackedFiles: ["src/existing.mjs", "src/new.mjs"],
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
        scope: "directory",
        metric: "files",
        glob: "src/**",
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

const stateSize = namedCheck(evaluateConstraintIR(sizeFacts, { executionPhase: "state" }), "size-rules");
const transactionSize = namedCheck(evaluateConstraintIR(sizeFacts, { executionPhase: "transaction" }), "size-rules");

expect("state size rules keep absolute repository invariant", stateSize.failed_rules.includes("state-absolute"), true);
expect("state size rules exclude changed-only invariant", stateSize.failed_rules.includes("transaction-changed"), false);
expect("state size rules strip growth facet from mixed invariant", stateSize.growth.length, 0);
expect("transaction size rules exclude pure absolute repository invariant", transactionSize.failed_rules.includes("state-absolute"), false);
expect("transaction size rules keep changed-only invariant", transactionSize.failed_rules.includes("transaction-changed"), true);
expect("transaction size rules keep growth facet from mixed invariant", transactionSize.failed_rules.includes("mixed-growth"), true);
expect("transaction size rules report mixed growth", transactionSize.growth.some((item) => item.ruleId === "mixed-growth"), true);

console.log(`\n${failures === 0 ? "All execution phase tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
