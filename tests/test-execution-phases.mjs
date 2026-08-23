import { createRuleRegistry } from "../dist/checks/rule-registry.mjs";

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

console.log(`\n${failures === 0 ? "All execution phase tests passed" : `${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
