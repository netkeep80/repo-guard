import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAuthenticatedProviderBundle, loadGitHubEvent } from "../dist/github-pr.mjs";

const providerTransition = (repository, authorityBaseRevision, baseRevision, headRevision) => ({
  repository, authorityBaseRevision, baseRevision, headRevision,
});

function withEventFile(content, run) {
  const dir = mkdtempSync(join(tmpdir(), "repo-guard-github-pr-boundary-"));
  const eventPath = join(dir, "event.json");
  const previous = process.env.GITHUB_EVENT_PATH;
  writeFileSync(eventPath, content);
  process.env.GITHUB_EVENT_PATH = eventPath;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previous;
    rmSync(dir, { recursive: true });
  }
}

describe("github PR event boundary", () => {
  it("contains malformed event JSON as an event_read_error", () => {
    const result = withEventFile("{bad", () => loadGitHubEvent());
    assert.equal(result.ok, false);
    assert.equal(result.error, "event_read_error");
    assert.match(result.message, /Cannot read event file:/);
  });

  it("preserves the PR event projection", () => {
    const event = {
      pull_request: {
        number: 42,
        base: { sha: "a".repeat(40), ref: "main" },
        head: { sha: "b".repeat(40) },
        body: "PR body",
      },
      repository: { full_name: "netkeep80/repo-guard" },
    };
    const result = withEventFile(JSON.stringify(event), () => loadGitHubEvent());
    assert.deepEqual(result, {
      ok: true,
      base: "a".repeat(40),
      baseRef: "main",
      head: "b".repeat(40),
      prBody: "PR body",
      prNumber: 42,
      repoFullName: "netkeep80/repo-guard",
    });
  });
});


describe("#752 authenticated provider production boundary", () => {
  it("accepts an exact provider claim only from an accepted pull_request_target workflow source", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-bundle-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: [{
        boundary: "domain",
        class: "domain",
        key: "domain:example",
        requirementId: "APP-01",
        subjectPaths: ["README.md"],
        status: "pass"
      }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle,
        runnerTemp: dir,
        eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: {
          repository: { full_name: "example/consumer" },
          pull_request: { base: { sha: base }, head: { sha: head } }
        },
        authorityBaseRevision: base,
        baseRevision: base,
        headRevision: head
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.equal(result.authenticatedProviderGrants.length, 1);
      assert.equal(result.evidenceFacts.length, 1);
      assert.equal(result.observationFacts.length, 0);
      assert.equal(result.evidenceFacts[0].key, "domain:example");
      assert.equal(result.evidenceFacts[0].status, "pass");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("keeps explicit zero-grant capability input when no provider bundle is configured", () => {
    const result = loadAuthenticatedProviderBundle({
      bundlePath: "",
      repository: "arbitrary/consumer",
      event: null,
      authorityBaseRevision: "a".repeat(40),
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40)
    });
    assert.equal(result.ok, true);
    assert.equal(result.present, false);
    assert.deepEqual(result.authenticatedProviderGrants, []);
    assert.deepEqual(result.observationFacts, []);
    assert.deepEqual(result.evidenceFacts, []);
  });

  it("rejects a provider bundle from candidate pull_request execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-candidate-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: []
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/ci.yml@refs/pull/1/merge",
        workflowSha: head,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.includes("A2:provider_untrusted_event"));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("rejects candidate-authored provider identity fields from the authenticated bundle schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-spoof-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: [{
        boundary: "domain", class: "domain", key: "domain:example", requirementId: "APP-01",
        subjectPaths: ["README.md"], status: "pass", providerId: "candidate"
      }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.some((reason) => reason.includes("unknown field")));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("rejects stale or non-base accepted-workflow source identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-stale-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: []
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: "c".repeat(40),
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.includes("A2:provider_workflow_source_not_exact_base"));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("maps exact authenticated OBSERVATION capability and fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-observation-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("another/consumer", base, base, head),
      claims: [{ boundary: "observation", metric: "git.changed_lines", path: "src/a.ts", value: 7 }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "another/consumer",
        workflowRef: "another/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: { repository: { full_name: "another/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.deepEqual(result.observationFacts.map(({ metric, path, value }) => ({ metric, path, value })),
        [{ metric: "changed_lines", path: "src/a.ts", value: 7 }]);
      assert.equal(result.authenticatedProviderGrants[0].boundary, "observation");
      assert.equal(result.authenticatedProviderGrants[0].capability.key, "git.changed_lines");
      assert.equal(result.authenticatedProviderGrants[0].repository, "another/consumer");
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("maps exact authenticated execution evidence with HEAD verifier identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-execution-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: [{
        boundary: "domain", class: "execution", key: "tests:core", requirementId: "APP-01",
        subjectPaths: ["src/a.ts"], status: "pass", verifierPath: "tests/core.test.mjs"
      }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.equal(result.evidenceFacts[0].verifierPath, "tests/core.test.mjs");
      assert.equal(result.evidenceFacts[0].verifierRevision, head);
      assert.equal(result.authenticatedProviderGrants[0].capability.verifierRevision, head);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("supports the exact post-cutover native state while authenticating the producer at legacy BASE", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-cutover-"));
    const bundle = join(dir, "provider.json");
    const legacyBase = "a".repeat(40), nativeHead = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", nativeHead, nativeHead, nativeHead),
      claims: [{ boundary: "domain", class: "domain", key: "domain:cutover", requirementId: "APP-01", subjectPaths: [], status: "pass" }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: legacyBase,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: legacyBase }, head: { sha: nativeHead } } },
        authorityBaseRevision: nativeHead, baseRevision: nativeHead, headRevision: nativeHead
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.equal(result.authenticatedProviderGrants[0].authorityBaseRevision, nativeHead);
      assert.match(result.authenticatedProviderGrants[0].producerSource, new RegExp("^" + legacyBase));
      assert.deepEqual(result.protectedResources, [".github/workflows/trusted-enforcement.yml"]);
      assert.equal(result.trust.authorityBaseRevision, legacyBase);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("rejects provider bundles outside RUNNER_TEMP", () => {
    const runner = mkdtempSync(join(tmpdir(), "repo-guard-provider-runner-"));
    const outside = mkdtempSync(join(tmpdir(), "repo-guard-provider-outside-"));
    const bundle = join(outside, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, head),
      claims: []
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: runner, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.some((reason) => reason.startsWith("A2:provider_bundle_path_invalid:")));
    } finally {
      rmSync(runner, { recursive: true });
      rmSync(outside, { recursive: true });
    }
  });


  it("routes authenticated DOMAIN evidence through the real generic native check-pr path", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-provider-native-consumer-"));
    const runner = mkdtempSync(join(tmpdir(), "repo-guard-provider-native-runner-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    const cli = fileURLToPath(new URL("../dist/repo-guard.mjs", import.meta.url));
    mkdirSync(join(root, "requirements"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "requirements", "APP-01.rg.yaml"), [
      "format: repo-guard/requirement-v1",
      "id: APP-01",
      'normative: "Application source changes require authenticated domain evidence."',
      "relations:",
      "  - predicates: [implemented_by]",
      "    target:",
      "      kind: artifact",
      '      path: "src/a.txt"',
      "constraints:",
      "  - id: authenticated-domain",
      "    scope:",
      "      relations: [implemented_by]",
      "      include_generated: false",
      "    evidence:",
      "      class: domain",
      '      key: "domain:app-review"',
      "",
    ].join("\n"));
    writeFileSync(join(root, "src", "a.txt"), "base\n");
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("add", "-A");
      git("commit", "-q", "-m", "native base");
      const base = git("rev-parse", "HEAD");
      git("remote", "add", "origin", root);
      git("checkout", "-q", "-b", "feature");
      writeFileSync(join(root, "src", "a.txt"), "head\n");
      git("add", "src/a.txt");
      git("commit", "-q", "-m", "native head");
      const head = git("rev-parse", "HEAD");
      const eventPath = join(runner, "event.json");
      const bundlePath = join(runner, "provider.json");
      const body = [
        "```repo-guard-yaml",
        "change_type: bugfix",
        "scope:",
        "  - src/a.txt",
        "budgets: {}",
        "anchors:",
        "  affects: [APP-01]",
        "  implements: []",
        "  verifies: []",
        "must_touch: []",
        "must_not_touch: []",
        "expected_effects:",
        "  - Exercise authenticated DOMAIN evidence",
        "```",
      ].join("\n");
      writeFileSync(eventPath, JSON.stringify({
        pull_request: { number: 1, base: { sha: base, ref: "main" }, head: { sha: head }, body },
        repository: { full_name: "arbitrary/native-consumer" },
      }));
      writeFileSync(bundlePath, JSON.stringify({
        format: "repo-guard/provider-bundle-v1",
        transition: providerTransition("arbitrary/native-consumer", base, base, head),
        claims: [{
          boundary: "domain",
          class: "domain",
          key: "domain:app-review",
          requirementId: "APP-01",
          subjectPaths: ["src/a.txt"],
          status: "pass",
        }],
      }));
      const commonEnv = {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_WORKFLOW_REF: "arbitrary/native-consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        GITHUB_WORKFLOW_SHA: base,
        RUNNER_TEMP: runner,
      };
      const noEvidence = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr", "--format", "json"], {
        cwd: root, env: commonEnv, encoding: "utf8",
      });
      assert.equal(noEvidence.status, 1, noEvidence.stdout + noEvidence.stderr);
      assert.match(noEvidence.stdout + noEvidence.stderr, /missing_evidence/);

      const withEvidence = spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr", "--format", "json"], {
        cwd: root,
        env: { ...commonEnv, RG_AUTHENTICATED_PROVIDER_BUNDLE: bundlePath },
        encoding: "utf8",
      });
      assert.equal(withEvidence.status, 0, withEvidence.stdout + withEvidence.stderr);
      assert.match(withEvidence.stdout, /"result"\s*:\s*"passed"/);
      assert.match(withEvidence.stdout, /"providerCapabilityMode"\s*:\s*true/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(runner, { recursive: true, force: true });
    }
  });


  it("rejects a stale provider bundle transition tuple instead of rebinding evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-provider-stale-tuple-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40), stale = "c".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("example/consumer", base, base, stale),
      claims: [{ boundary: "domain", class: "domain", key: "domain:example", requirementId: "APP-01", subjectPaths: [], status: "pass" }]
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle, runnerTemp: dir, eventName: "pull_request_target",
        repository: "example/consumer",
        workflowRef: "example/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: { repository: { full_name: "example/consumer" }, pull_request: { base: { sha: base }, head: { sha: head } } },
        authorityBaseRevision: base, baseRevision: base, headRevision: head
      });
      assert.equal(result.ok, false);
      assert.ok(result.reasons.some((reason) => reason.includes("provider bundle HEAD is stale or mismatched")));
    } finally { rmSync(dir, { recursive: true }); }
  });

});


describe("#756 ProtectedResource TRUST production boundary", () => {
  it("RED: accepted provider boundary transports exact ProtectedResource TRUST separately from DOMAIN/OBSERVATION", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-protected-trust-red-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("external/consumer", base, base, head),
      claims: [],
      trust: {
        repository: "external/consumer",
        authorityBaseRevision: base,
        protectedResources: [".github/workflows/trusted-enforcement.yml"]
      }
    }));
    try {
      const result = loadAuthenticatedProviderBundle({
        bundlePath: bundle,
        runnerTemp: dir,
        eventName: "pull_request_target",
        repository: "external/consumer",
        workflowRef: "external/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
        workflowSha: base,
        event: {
          repository: { full_name: "external/consumer" },
          pull_request: { base: { sha: base }, head: { sha: head } }
        },
        authorityBaseRevision: base,
        baseRevision: base,
        headRevision: head
      });
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.deepEqual(result.protectedResources, [".github/workflows/trusted-enforcement.yml"]);
      assert.deepEqual(result.authenticatedProviderGrants, []);
      assert.deepEqual(result.evidenceFacts, []);
      assert.deepEqual(result.observationFacts, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});


describe("#756 authenticated ProtectedResource TRUST adversarial boundary", () => {
  const authInput = (overrides = {}) => {
    const base = "a".repeat(40), head = "b".repeat(40);
    return {
      bundlePath: "",
      eventName: "pull_request_target",
      repository: "external/consumer",
      workflowRef: "external/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
      workflowSha: base,
      event: {
        repository: { full_name: "external/consumer" },
        pull_request: { base: { sha: base }, head: { sha: head } },
      },
      authorityBaseRevision: base,
      baseRevision: base,
      headRevision: head,
      ...overrides,
    };
  };

  it("P2/P10/P17 exact accepted workflow is intrinsically protected with zero provider grants", () => {
    const result = loadAuthenticatedProviderBundle(authInput());
    assert.equal(result.ok, true, result.reasons.join(" | "));
    assert.equal(result.present, false);
    assert.equal(result.trustPresent, true);
    assert.deepEqual(result.protectedResources, [".github/workflows/trusted-enforcement.yml"]);
    assert.deepEqual(result.authenticatedProviderGrants, []);
    assert.deepEqual(result.evidenceFacts, []);
    assert.deepEqual(result.observationFacts, []);
    assert.equal(result.trust.source, "accepted-workflow");
  });

  it("P9 candidate pull_request execution cannot mint ProtectedResource TRUST", () => {
    const result = loadAuthenticatedProviderBundle(authInput({
      eventName: "pull_request",
      workflowRef: "external/consumer/.github/workflows/ci.yml@refs/pull/1/merge",
      workflowSha: "b".repeat(40),
    }));
    assert.equal(result.ok, true);
    assert.equal(result.trustPresent, false);
    assert.deepEqual(result.protectedResources, []);
  });

  it("P10 empty authenticated declaration cannot remove intrinsic accepted workflow protection", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-protected-empty-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("external/consumer", base, base, head),
      claims: [],
      trust: {
        repository: "external/consumer",
        authorityBaseRevision: base,
        protectedResources: [],
      },
    }));
    try {
      const result = loadAuthenticatedProviderBundle(authInput({ bundlePath: bundle, runnerTemp: dir }));
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.deepEqual(result.protectedResources, [".github/workflows/trusted-enforcement.yml"]);
      assert.deepEqual(result.authenticatedProviderGrants, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("P7/P10 TRUST declaration is exact-repository and accepted-BASE bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-protected-binding-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    const write = (trust) => writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("external/consumer", base, base, head),
      claims: [],
      trust,
    }));
    try {
      write({ repository: "other/repo", authorityBaseRevision: base, protectedResources: ["src/a.ts"] });
      let result = loadAuthenticatedProviderBundle(authInput({ bundlePath: bundle, runnerTemp: dir }));
      assert.equal(result.ok, false);
      assert.ok(result.reasons.some((reason) => reason.includes("trust repository")));

      write({ repository: "external/consumer", authorityBaseRevision: "c".repeat(40), protectedResources: ["src/a.ts"] });
      result = loadAuthenticatedProviderBundle(authInput({ bundlePath: bundle, runnerTemp: dir }));
      assert.equal(result.ok, false);
      assert.ok(result.reasons.some((reason) => reason.includes("trust authority BASE")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("P18/P19 DOMAIN/OBSERVATION claims remain disjoint from ProtectedResource TRUST", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-guard-protected-separation-"));
    const bundle = join(dir, "provider.json");
    const base = "a".repeat(40), head = "b".repeat(40);
    writeFileSync(bundle, JSON.stringify({
      format: "repo-guard/provider-bundle-v1",
      transition: providerTransition("external/consumer", base, base, head),
      claims: [
        { boundary: "observation", metric: "git.changed_lines", path: "src/a.ts", value: 3 },
        { boundary: "domain", class: "domain", key: "domain:review", requirementId: "APP-01", subjectPaths: ["src/a.ts"], status: "pass" },
      ],
    }));
    try {
      const result = loadAuthenticatedProviderBundle(authInput({ bundlePath: bundle, runnerTemp: dir }));
      assert.equal(result.ok, true, result.reasons.join(" | "));
      assert.deepEqual(result.protectedResources, [".github/workflows/trusted-enforcement.yml"]);
      assert.equal(result.authenticatedProviderGrants.length, 2);
      assert.equal(result.observationFacts.length, 1);
      assert.equal(result.evidenceFacts.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("P1/P3/P9/P15/P17/P20 real generic native check-pr protects accepted producer without repository special case", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-guard-756-native-consumer-"));
    const runner = mkdtempSync(join(tmpdir(), "repo-guard-756-native-runner-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    const cli = fileURLToPath(new URL("../dist/repo-guard.mjs", import.meta.url));
    const workflowPath = ".github/workflows/trusted-enforcement.yml";
    mkdirSync(join(root, "requirements"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, "requirements", "APP-01.rg.yaml"), [
      "format: repo-guard/requirement-v1",
      "id: APP-01",
      'normative: "Application and accepted trust producer are governed resources."',
      "relations:",
      "  - predicates: [implemented_by]",
      "    target:",
      "      kind: artifact",
      '      path: "src/a.txt"',
      "  - predicates: [implemented_by]",
      "    target:",
      "      kind: artifact",
      '      path: ".github/workflows/trusted-enforcement.yml"',
      "",
    ].join("\n"));
    writeFileSync(join(root, "src", "a.txt"), "base\n");
    writeFileSync(join(root, workflowPath), "name: accepted trust producer\n");
    const body = [
      "```repo-guard-yaml",
      "change_type: bugfix",
      "scope:",
      "  - src/a.txt",
      "  - .github/workflows/trusted-enforcement.yml",
      "budgets: {}",
      "anchors:",
      "  affects: [APP-01]",
      "  implements: []",
      "  verifies: []",
      "must_touch: []",
      "must_not_touch: []",
      "expected_effects:",
      "  - Exercise generic ProtectedResource TRUST",
      "```",
    ].join("\n");
    const eventPath = join(runner, "event.json");
    try {
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("add", "-A");
      git("commit", "-q", "-m", "native base");
      const base = git("rev-parse", "HEAD");
      git("remote", "add", "origin", root);

      const run = (head) => {
        writeFileSync(eventPath, JSON.stringify({
          pull_request: { number: 1, base: { sha: base, ref: "main" }, head: { sha: head }, body },
          repository: { full_name: "arbitrary/native-consumer" },
        }));
        return spawnSync(process.execPath, [cli, "--repo-root", root, "check-pr", "--format", "json"], {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_EVENT_NAME: "pull_request_target",
            GITHUB_WORKFLOW_REF: "arbitrary/native-consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
            GITHUB_WORKFLOW_SHA: base,
            RUNNER_TEMP: runner,
          },
          encoding: "utf8",
        });
      };

      git("checkout", "-q", "-b", "ordinary");
      writeFileSync(join(root, "src", "a.txt"), "ordinary head\n");
      git("add", "src/a.txt");
      git("commit", "-q", "-m", "ordinary source change");
      const ordinaryHead = git("rev-parse", "HEAD");
      const ordinary = run(ordinaryHead);
      assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
      assert.match(ordinary.stdout, /"providerCapabilityMode"\s*:\s*true/);
      assert.match(ordinary.stdout, /"authenticatedProviderGrantCount"\s*:\s*0/);
      assert.match(ordinary.stdout, /\.github\/workflows\/trusted-enforcement\.yml/);

      git("checkout", "-q", "-B", "protected", base);
      writeFileSync(join(root, workflowPath), "name: candidate-mutated trust producer\n");
      git("add", workflowPath);
      git("commit", "-q", "-m", "mutate protected producer");
      const protectedHead = git("rev-parse", "HEAD");
      const protectedRun = run(protectedHead);
      assert.equal(protectedRun.status, 1, protectedRun.stdout + protectedRun.stderr);
      assert.match(protectedRun.stdout + protectedRun.stderr,
        /missing_authority:resource:\.github\/workflows\/trusted-enforcement\.yml/);
      assert.match(protectedRun.stdout, /"evaluator"\s*:\s*"native"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(runner, { recursive: true, force: true });
    }
  });
});


test("#756 accepted ProtectedResource source is exact BASE-bound, not candidate HEAD-bound", () => {
  const base = "a".repeat(40), head = "b".repeat(40);
  const result = loadAuthenticatedProviderBundle({
    bundlePath: "",
    eventName: "pull_request_target",
    repository: "external/consumer",
    workflowRef: "external/consumer/.github/workflows/trusted-enforcement.yml@refs/heads/main",
    workflowSha: head,
    event: {
      repository: { full_name: "external/consumer" },
      pull_request: { base: { sha: base }, head: { sha: head } },
    },
    authorityBaseRevision: base,
    baseRevision: base,
    headRevision: head,
  });
  assert.equal(result.ok, false);
  assert.equal(result.trustPresent, false);
  assert.deepEqual(result.protectedResources, []);
  assert.ok(result.reasons.includes("A2:provider_workflow_source_not_exact_base"));
});
