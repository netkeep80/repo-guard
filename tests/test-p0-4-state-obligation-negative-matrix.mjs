import assert from "node:assert/strict";
import { buildStateObligationPlan } from "../dist/checks/state-obligation-plan.mjs";
import { compileConstraintProgram } from "../dist/checks/constraint-program.mjs";

const PIN_POINTER = "/document_relations/rules/pin";
const PERMISSION_POINTER = "/document_relations/rules/permission";
const TRANSITION_POINTER = "/document_relations/rules/transition";
const trusted = { trusted: true, source: "repository_permission" };
const untrusted = { trusted: false, source: "repository_permission", reason: "permission_insufficient" };

const stateRule = (id, value, pointer = `/${id}`) => ({
  id,
  kind: "scalar_equals_literal",
  source: { document: "workflow", pointer, type: "string" },
  value,
});

const transitionRule = (pointer = "/version") => ({
  id: "transition",
  kind: "scalar_strictly_greater",
  left: { document: "version", snapshot: "head", pointer, type: "string" },
  right: { document: "version", snapshot: "base", pointer: "/version", type: "string" },
  comparator: "semver",
});

function policy({
  pin = "old",
  pinPointer = "/pin",
  includePin = true,
  permission = "read",
  transitionPointer = "/version",
} = {}) {
  return {
    paths: {
      forbidden: [],
      governance_paths: ["repo-policy.json"],
      operational_paths: [],
      canonical_docs: [],
      pr_immutable: ["protected.lock"],
    },
    document_relations: {
      documents: {
        workflow: { path: ".github/workflows/repo-guard.yml", format: "yaml" },
        version: { path: "package.json", format: "json" },
      },
      rules: [
        ...(includePin ? [stateRule("pin", pin, pinPointer)] : []),
        stateRule("permission", permission, "/permission"),
        transitionRule(transitionPointer),
      ],
    },
  };
}

function plan(basePolicy, headPolicy, allowPolicyRelaxation, authorizer = trusted) {
  return buildStateObligationPlan({
    policy: basePolicy,
    basePolicy,
    headPolicy,
    diff: { files: { checked: [{ path: "repo-policy.json" }] } },
    trustedAuthorizer: authorizer,
    governanceGrant: allowPolicyRelaxation === null ? null : { allow_policy_relaxation: allowPolicyRelaxation },
    changeIntent: { change_type: "governance" },
  });
}

function replacedKeys(result) {
  assert.ok(result, "policy delta must produce an obligation plan");
  return result.replaced_base_state_constraints.map((item) => item.key);
}

{
  const base = policy(), head = policy({ pin: "new" });
  const result = plan(base, head, [PIN_POINTER]);
  assert.equal(result.policy_delta_authorized, true);
  assert.equal(result.exact_policy_delta_authorized, true);
  assert.deepEqual(result.policy_delta_pointers, [PIN_POINTER]);
  assert.deepEqual(replacedKeys(result), ["document-relation:pin"]);
  assert.deepEqual(result.unreplaced_authorized_state_pointers, []);
  assert.ok(!replacedKeys(result).includes("document-relation:permission"), "unchanged BASE state obligation must remain mandatory");
  assert.ok(!replacedKeys(result).some((key) => key.startsWith("paths:pr-immutable")), "PR-immutable obligations must never enter the replacement set");
}

{
  const base = policy(), head = policy({ pin: "new" });
  const result = plan(base, head, null);
  assert.equal(result.policy_delta_authorized, false);
  assert.deepEqual(replacedKeys(result), []);
}

{
  const base = policy(), head = policy({ pin: "new" });
  const result = plan(base, head, [PERMISSION_POINTER]);
  assert.equal(result.policy_delta_authorized, false);
  assert.deepEqual(replacedKeys(result), []);
}

{
  const base = policy(), head = policy({ pin: "new" });
  const result = plan(base, head, ["/document_relations"]);
  assert.equal(result.policy_delta_authorized, true, "existing policy-delta semantics may accept an explicitly broad parent pointer");
  assert.equal(result.exact_policy_delta_authorized, false, "state replacement requires exact normalized pointer identity");
  assert.deepEqual(result.authorization_reasons, ["state_replacement_requires_exact_policy_delta_pointers"]);
  assert.deepEqual(replacedKeys(result), []);
}

{
  const base = policy(), head = policy({ pin: "new" });
  const result = plan(base, head, [PIN_POINTER], untrusted);
  assert.equal(result.policy_delta_authorized, false);
  assert.deepEqual(replacedKeys(result), []);
}

{
  const base = policy(), head = policy({ pin: "new", pinPointer: "/relocated-pin" });
  const result = plan(base, head, [PIN_POINTER]);
  assert.equal(result.exact_policy_delta_authorized, true);
  assert.deepEqual(replacedKeys(result), [], "selector relocation cannot inherit state-replacement authority");
  assert.deepEqual(result.unreplaced_authorized_state_pointers, [PIN_POINTER]);
}

{
  const base = policy(), head = policy({ includePin: false });
  const result = plan(base, head, [PIN_POINTER]);
  assert.equal(result.exact_policy_delta_authorized, true);
  assert.deepEqual(replacedKeys(result), [], "removal is not replacement");
  assert.deepEqual(result.unreplaced_authorized_state_pointers, [PIN_POINTER]);
}

{
  const base = policy(), head = policy({ pin: "new", permission: "write" });
  const result = plan(base, head, [PIN_POINTER]);
  assert.deepEqual(result.policy_delta_pointers, [PERMISSION_POINTER, PIN_POINTER].sort());
  assert.equal(result.policy_delta_authorized, false, "one covered state replacement cannot waive another policy delta");
  assert.deepEqual(replacedKeys(result), []);
}

{
  const base = policy(), head = policy({ transitionPointer: "/release" });
  const result = plan(base, head, [TRANSITION_POINTER]);
  assert.equal(result.exact_policy_delta_authorized, true);
  assert.deepEqual(replacedKeys(result), [], "transaction obligation cannot be replaced as state");
  assert.deepEqual(result.unreplaced_authorized_state_pointers, [TRANSITION_POINTER]);
}

{
  const entries = compileConstraintProgram(policy(), null);
  const immutableMutation = entries.find((entry) => entry.key === "paths:pr-immutable:mutation");
  const immutablePolicySet = entries.find((entry) => entry.key === "paths:pr-immutable:policy-set");
  assert.equal(immutableMutation?.runtime?.phase, "transaction");
  assert.equal(immutablePolicySet?.runtime?.phase, "transaction");
}

console.log("P0.4 state-obligation negative matrix passed");
