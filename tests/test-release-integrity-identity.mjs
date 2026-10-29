import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";

import { validateEligibilityEvidence } from "../scripts/release-preflight.mjs";

const exactSha = "a".repeat(40);

function yaml(path) {
  const source = readFileSync(resolve(path), "utf8");
  const document = parseDocument(source);
  assert.deepEqual(document.errors, [], path);
  return document.toJS();
}

function stepsText(job) {
  return (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
}

function assertPinnedActions(workflow, label) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses === undefined) continue;
      assert.match(
        step.uses,
        /^[^@]+@[0-9a-f]{40}$/,
        `${label} ${jobName} uses non-pinned Action ${step.uses}`,
      );
    }
  }
}

describe("#835 atomic release trusted boundary", () => {
  const workflow = yaml(".github/workflows/release.yml");
  const eligibility = workflow.jobs?.eligibility;
  const publish = workflow.jobs?.publish;

  it("preserves repository_dispatch release and release concurrency semantics", () => {
    assert.deepEqual(workflow.on?.repository_dispatch?.types, ["release"]);
    assert.deepEqual(workflow.permissions, {});
    assert.equal(workflow.concurrency?.group, "release");
    assert.equal(workflow.concurrency?.["cancel-in-progress"], false);
  });

  it("F1 target-owned preflight substitution is ineffective", () => {
    assert.ok(eligibility);
    assert.deepEqual(eligibility.permissions, { actions: "read", contents: "read" });
    const checkout = eligibility.steps.find((step) => step.name === "Checkout trusted release evaluator");
    assert.ok(checkout);
    assert.equal(checkout.with?.ref, "${{ github.sha }}");
    assert.equal(checkout.with?.["persist-credentials"], false);
    assert.notEqual(checkout.with?.ref, "${{ github.event.client_payload.sha }}");

    const acquire = eligibility.steps.find((step) => step.name === "Acquire exact release target as data");
    assert.ok(acquire);
    assert.match(acquire.run, /git fetch --no-tags --prune origin "\$TARGET_SHA"/);
    assert.match(acquire.run, /git cat-file -e "\$TARGET_SHA\^\{commit\}"/);
    assert.doesNotMatch(acquire.run, /git checkout|git switch/);

    const proof = eligibility.steps.find((step) => step.id === "proof");
    assert.ok(proof);
    assert.match(proof.run, /node scripts\/release-preflight\.mjs eligibility/);
    assert.match(String(proof.env?.EVALUATOR_SHA), /github\.sha/);
    assert.match(String(proof.env?.TARGET_SHA), /client_payload\.sha/);
    assert.doesNotMatch(stepsText(eligibility), /npm\s+(?:ci|install|run)/);
  });

  it("F2 forged legacy three-field proof is rejected by exact evidence schema", () => {
    assert.throws(
      () => validateEligibilityEvidence({
        sha: exactSha,
        version: "5.0.0",
        tag: "v5.0.0",
      }),
      /unexpected fields/i,
    );
  });

  it("authorizer policy is explicit and executes before trusted checkout", () => {
    const first = eligibility.steps?.[0];
    assert.equal(first?.name, "Authorize exact release dispatch");
    assert.match(first.run, /netkeep80\/repo-guard/);
    assert.match(first.run, /test "\$ACTOR" = "netkeep80"/);
    assert.match(first.run, /repository_dispatch/);
    assert.match(first.run, /release/);
    assert.match(String(first.env?.TARGET_SHA), /client_payload\.sha/);
  });

  it("trusted evidence is versioned and bound to evaluator, target, CI and current run", () => {
    const proof = eligibility.steps.find((step) => step.id === "proof");
    assert.match(proof.run, /schema_version == 2/);
    for (const field of [
      "eligibility",
      "repository",
      "target_sha",
      "version",
      "tag",
      "evaluator_sha",
      "ci_run_id",
      "ci_run_attempt",
      "source_release_run_id",
      "source_release_run_attempt",
    ]) {
      assert.match(proof.run, new RegExp(field));
    }

    const upload = eligibility.steps.find((step) => step.name === "Upload trusted release eligibility evidence");
    assert.equal(upload?.uses, "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    assert.equal(upload?.with?.name, "release-eligibility-${{ github.run_id }}-${{ github.run_attempt }}");
    assert.equal(upload?.with?.path, "release-eligibility.json");
    assert.equal(upload?.with?.["if-no-files-found"], "error");
  });

  it("privileged publish consumes only trusted eligibility outputs and executes no repository code", () => {
    assert.ok(publish);
    assert.equal(publish.needs, "eligibility");
    assert.deepEqual(publish.permissions, { contents: "write" });
    assert.match(String(publish.env?.TARGET_SHA), /needs\.eligibility\.outputs\.target_sha/);
    assert.match(String(publish.env?.VERSION), /needs\.eligibility\.outputs\.version/);
    assert.match(String(publish.env?.TAG), /needs\.eligibility\.outputs\.tag/);
    assert.doesNotMatch(JSON.stringify(publish), /client_payload/);

    for (const step of publish.steps ?? []) assert.equal(step.uses, undefined);
    const text = stepsText(publish);
    assert.doesNotMatch(text, /\bnpm\b/);
    assert.doesNotMatch(text, /\bnode\b/);
    assert.doesNotMatch(text, /scripts\//);
    assert.doesNotMatch(text, /git checkout|git switch/);
    assert.match(text, /SOURCE_RUN_ID.*CURRENT_RUN_ID/s);
    assert.match(text, /SOURCE_RUN_ATTEMPT.*CURRENT_RUN_ATTEMPT/s);
  });

  it("does not interpolate payload-controlled expressions directly into shell bodies", () => {
    for (const step of eligibility.steps ?? []) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
    }
    for (const step of publish.steps ?? []) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
    }
  });

  it("keeps all Actions immutable-SHA pinned", () => {
    assertPinnedActions(workflow, "release");
  });
});

describe("#835 automatic release integrity trusted boundary", () => {
  const workflow = yaml(".github/workflows/release-integrity.yml");
  const resolveTarget = workflow.jobs?.["resolve-automatic-target"];
  const verify = workflow.jobs?.["verify-automatic"];
  const record = workflow.jobs?.["record-automatic-evidence"];
  const manual = workflow.jobs?.["verify-manual"];

  it("preserves automatic Atomic release completion plus separate manual diagnostic", () => {
    assert.deepEqual(workflow.on?.workflow_run?.workflows, ["Atomic release"]);
    assert.deepEqual(workflow.on?.workflow_run?.types, ["completed"]);
    assert.ok(workflow.on?.workflow_dispatch?.inputs?.tag);
    assert.deepEqual(workflow.permissions, {});
  });

  it("validates source repository/path/event/run identity before accepting eligibility artifact", () => {
    assert.ok(resolveTarget);
    assert.deepEqual(resolveTarget.permissions, { actions: "read", contents: "read" });
    const text = JSON.stringify(resolveTarget);
    assert.doesNotMatch(text, /actions\/checkout/);
    assert.doesNotMatch(text, /actions\/setup-node/);
    assert.doesNotMatch(text, /npm\s/);
    assert.doesNotMatch(text, /scripts\//);
    assert.match(text, /workflow_run\.repository\.full_name/);
    assert.match(text, /workflow_run\.path/);
    assert.match(text, /workflow_run\.event/);
    assert.match(text, /workflow_run\.id/);
    assert.match(text, /workflow_run\.run_attempt/);
    assert.match(text, /\.github\/workflows\/release\.yml/);
    assert.match(text, /repository_dispatch/);
    assert.match(text, /release-eligibility-/);
    assert.match(text, /schema_version/);
    assert.match(text, /evaluator_sha/);
    assert.match(text, /ci_run_id/);
  });

  it("F3 target-owned automatic integrity verifier is no longer executed", () => {
    assert.ok(verify);
    assert.equal(verify.needs, "resolve-automatic-target");
    assert.deepEqual(verify.permissions, { actions: "read", contents: "read" });

    const checkout = verify.steps.find((step) => step.name === "Checkout trusted integrity evaluator");
    assert.ok(checkout);
    assert.equal(checkout.with?.ref, "${{ github.sha }}");
    assert.notEqual(checkout.with?.ref, "${{ needs.resolve-automatic-target.outputs.target_sha }}");
    assert.equal(checkout.with?.["persist-credentials"], false);

    const acquire = verify.steps.find((step) => step.name === "Acquire published target as data");
    assert.match(acquire?.run ?? "", /git fetch --no-tags --prune origin "\$TARGET_SHA"/);
    assert.doesNotMatch(acquire?.run ?? "", /git checkout|git switch/);

    const verifier = verify.steps.find((step) => step.name === "Verify publication with trusted integrity evaluator");
    assert.match(verifier?.run ?? "", /node scripts\/release-preflight\.mjs integrity/);
    assert.doesNotMatch(verifier?.run ?? "", /verify-release-ref\.mjs/);
    assert.match(String(verifier?.env?.VERIFIER_SHA), /github\.sha/);
  });

  it("F27 target workflow substitution cannot select evaluator provenance", () => {
    const automaticCheckout = verify.steps.find((step) => step.name === "Checkout trusted integrity evaluator");
    assert.equal(automaticCheckout?.with?.ref, "${{ github.sha }}");
    assert.doesNotMatch(JSON.stringify(automaticCheckout), /client_payload/);

    const release = yaml(".github/workflows/release.yml");
    const eligibilityCheckout = release.jobs?.eligibility?.steps?.find(
      (step) => step.name === "Checkout trusted release evaluator",
    );
    assert.equal(eligibilityCheckout?.with?.ref, "${{ github.sha }}");
    assert.doesNotMatch(JSON.stringify(eligibilityCheckout), /client_payload/);
  });

  it("records exact trusted verifier identity even when verification fails", () => {
    assert.ok(record);
    assert.deepEqual(record.needs, ["resolve-automatic-target", "verify-automatic"]);
    assert.match(String(record.if), /always\(\)/);
    assert.match(String(record.if), /resolve-automatic-target.*success/);
    assert.doesNotMatch(JSON.stringify(record), /actions\/checkout/);

    const text = JSON.stringify(record);
    assert.match(text, /needs\.verify-automatic\.result/);
    assert.match(text, /eligibility_evaluator_sha/);
    assert.match(text, /verifier_sha/);
    assert.match(text, /github\.sha/);
    assert.match(text, /target_sha/);
    assert.match(text, /source_release_run_id/);
    assert.match(text, /source_release_run_attempt/);
    assert.match(text, /github\.run_id/);
    assert.match(text, /github\.run_attempt/);
    assert.match(text, /run_url/);
    assert.match(text, /conclusion/);
    assert.match(text, /release-integrity-/);
  });


  it("#852 RED selected historical tag can substitute the manual verifier implementation", () => {
    const manual = workflow.jobs?.["verify-manual"];
    assert.ok(manual);

    const checkout = manual.steps.find((step) => /Checkout selected release tag/.test(step.name ?? ""));
    const verifier = manual.steps.find((step) => /Verify selected published release tag/.test(step.name ?? ""));
    assert.equal(checkout?.with?.ref, "${{ inputs.tag }}");
    assert.match(verifier?.run ?? "", /node scripts\/verify-release-ref\.mjs/);

    const root = mkdtempSync(join(process.env.RUNNER_TEMP || process.cwd(), "repo-guard-852-red-"));
    const marker = join(root, "TARGET_OWNED_VERIFIER_EXECUTED");
    const runGit = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const put = (path, value) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, value);
    };
    try {
      runGit("init", "-q", "--object-format=sha1");
      put("TRUSTED-EVALUATOR", "trusted evaluator base\n");
      runGit("add", "-A");
      runGit("-c", "user.name=#852", "-c", "user.email=852@example.invalid", "commit", "-qm", "trusted evaluator");
      const evaluatorSha = runGit("rev-parse", "HEAD");

      put("scripts/verify-release-ref.mjs",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`);
      put("package.json", JSON.stringify({ name: "repo-guard", version: "1.2.3" }));
      runGit("add", "-A");
      runGit("-c", "user.name=#852", "-c", "user.email=852@example.invalid", "commit", "-qm", "historical target");
      const targetSha = runGit("rev-parse", "HEAD");
      runGit("tag", "v1.2.3", targetSha);

      const selectedTag = "v1.2.3";
      const executionRef = selectedTag; // current workflow: checkout.ref = inputs.tag
      runGit("checkout", "-q", executionRef);
      execFileSync(process.execPath, ["scripts/verify-release-ref.mjs"], { cwd: root });

      console.log("#852 RED_TARGET_SHA=" + targetSha);
      console.log("#852 RED_EVALUATOR_SHA=" + evaluatorSha);
      assert.notEqual(targetSha, evaluatorSha);
      assert.equal(
        existsSync(marker),
        false,
        "selected historical target can substitute and execute its own manual verifier",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps manual tag verification separate from trusted automatic evidence", () => {
    assert.ok(manual);
    assert.match(String(manual.if), /workflow_dispatch/);
    const text = JSON.stringify(manual);
    assert.match(text, /inputs\.tag/);
    assert.match(text, /verify-release-ref\.mjs/);
    assert.doesNotMatch(text, /source_release_run_id/);
  });

  it("keeps automatic evaluator read-only and all Actions pinned", () => {
    assert.deepEqual(verify.permissions, { actions: "read", contents: "read" });
    assertPinnedActions(workflow, "release-integrity");
  });

  it("does not interpolate source/target expressions directly into automatic shell bodies", () => {
    for (const job of [resolveTarget, verify, record]) {
      for (const step of job?.steps ?? []) {
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{/);
      }
    }
  });
});

console.log("#835 release trust structural contract passed");
