import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getDiff, readBasePolicy, resolveRemoteBaseRef } from "./git.mjs";
import {
  extractContract,
  extractIssueAuthorization,
  extractLinkedIssueNumbers,
  resolveContract,
  stripPrivilegedSchemaUnknownFields,
} from "./markdown-contract.mjs";
import { warnReservedContractFields } from "./policy-compiler.mjs";
import { resolveEnforcementMode } from "./enforcement.mjs";
import { loadPolicyRuntime, loadPolicyRuntimeFromObject, validationCheck } from "./runtime/validation.mjs";
import { runPolicyPipeline } from "./runtime/pipeline.mjs";
import { resolveTrustedAuthorizer } from "./trusted-authorizer.mjs";

const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_NUMBER = /^[1-9][0-9]*$/;

export function loadGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return { ok: false, error: "no_event", message: "GITHUB_EVENT_PATH not set; not running in GitHub Actions" };
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (error) {
    return { ok: false, error: "event_read_error", message: `Cannot read event file: ${error.message}` };
  }
  const pr = event.pull_request;
  if (!pr) return { ok: false, error: "not_pr_event", message: "GitHub event does not contain pull_request data" };
  return {
    ok: true,
    base: pr.base?.sha,
    baseRef: pr.base?.ref,
    head: pr.head?.sha,
    prBody: pr.body || "",
    prNumber: pr.number,
    repoFullName: event.repository?.full_name || process.env.GITHUB_REPOSITORY || "",
  };
}

export function fetchIssueBody(repoFullName, issueNumber) {
  const number = String(issueNumber);
  if (!GITHUB_REPO_FULL_NAME.test(repoFullName) || !ISSUE_NUMBER.test(number)) return null;
  try {
    return execFileSync("gh", ["api", `repos/${repoFullName}/issues/${number}`, "--jq", ".body"], {
      encoding: "utf-8",
      timeout: 30000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function cliAvailable(command) {
  try {
    execFileSync(command, ["--version"], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function checkPrerequisites() {
  const missing = [];
  if (!process.env.GITHUB_EVENT_PATH) missing.push("GITHUB_EVENT_PATH env var (set automatically by GitHub Actions)");
  if (!cliAvailable("git")) missing.push("git CLI (required for diff analysis)");
  return missing;
}

export function checkIssueFallbackPrerequisites() {
  return cliAvailable("gh") ? [] : ["gh CLI (required for linked issue fallback)"];
}

export function resolvePRContractFacts({ prBody, issueBody = null, linkedIssueCount = null }) {
  const linkedIssues = extractLinkedIssueNumbers(prBody);
  const issueAuthorization = extractIssueAuthorization(issueBody);
  const prResult = extractContract(prBody);
  if (prResult.ok) return { ok: true, contract: prResult.contract, contractSource: "pr body", linkedIssues, issueAuthorization };
  if (prResult.error !== "contract_not_found") {
    return { ok: false, error: prResult.error, message: prResult.message, contractSource: "pr body", linkedIssues, issueAuthorization };
  }
  const count = linkedIssueCount ?? linkedIssues.length;
  if (count > 1) {
    return {
      ok: false,
      error: "issue_link_ambiguous",
      message: `PR body references ${count} issues (${linkedIssues.map((n) => `#${n}`).join(", ")}); expected exactly one`,
      contractSource: "none",
      linkedIssues,
      issueAuthorization,
    };
  }
  const issueResult = resolveContract(prBody, issueBody);
  if (issueResult.ok) return { ok: true, contract: issueResult.contract, contractSource: "linked issue", linkedIssues, issueAuthorization };
  return { ok: false, error: issueResult.error, message: issueResult.message, contractSource: "none", linkedIssues, issueAuthorization };
}

function loadRuntime(load, { label, failureMessage }) {
  try {
    const runtime = load();
    if (runtime.ok) return runtime;
  } catch (error) {
    console.error(`FAIL: ${label}\n  ${error.message}`);
  }
  console.error(`\n${failureMessage}`);
  return null;
}

function printMissing(title, missing) {
  console.error(title);
  for (const item of missing) console.error(`  - ${item}`);
}

function fetchLinkedIssue({ prBody, repoFullName }) {
  const linkedIssues = extractLinkedIssueNumbers(prBody);
  const prResult = extractContract(prBody);
  const hasPrContract = prResult.ok;
  const needsFallback = !hasPrContract && prResult.error === "contract_not_found" && linkedIssues.length === 1;
  if (linkedIssues.length !== 1 || (!needsFallback && !hasPrContract)) return { linkedIssues, issueBody: null, fatal: false };

  console.log(needsFallback
    ? `No contract in PR body; trying linked issue #${linkedIssues[0]}...`
    : `Fetching linked issue #${linkedIssues[0]} for privileged authorization...`);
  const missing = checkIssueFallbackPrerequisites();
  if (missing.length > 0) {
    if (needsFallback) {
      printMissing("ERROR: linked issue fallback prerequisites not met:", missing);
      return { linkedIssues, issueBody: null, fatal: true };
    }
    console.warn("WARN: linked issue lookup prerequisites not met; privileged authorization from the issue body will be unavailable");
    for (const item of missing) console.warn(`  - ${item}`);
    return { linkedIssues, issueBody: null, fatal: false };
  }

  const issueBody = fetchIssueBody(repoFullName, linkedIssues[0]);
  if (issueBody === null && hasPrContract) {
    console.warn(`WARN: could not fetch linked issue #${linkedIssues[0]} body; privileged authorization from the issue body will be unavailable`);
  }
  return { linkedIssues, issueBody, fatal: false };
}

export function runCheckPR(roots, args = []) {
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) {
    console.error(`Unknown option for check-pr: ${unknown}\nUsage: repo-guard check-pr [--enforcement <advisory|blocking>]`);
    return 1;
  }

  const prereqs = checkPrerequisites();
  if (prereqs.length > 0) {
    printMissing("ERROR: check-pr prerequisites not met:", prereqs);
    console.error("\ncheck-pr expects to run inside a GitHub Actions pull_request workflow.\nRequired: GITHUB_EVENT_PATH and git with sufficient fetch depth.");
    return 1;
  }

  const event = loadGitHubEvent();
  if (!event.ok) {
    console.error(`ERROR: ${event.message}`);
    return 1;
  }
  const { base: eventBase, baseRef, head, prBody, prNumber, repoFullName } = event;
  if (!eventBase || !head) {
    console.error("ERROR: pull_request event missing base/head SHA");
    return 1;
  }

  let base = eventBase;
  if (baseRef) {
    try {
      base = resolveRemoteBaseRef(baseRef, roots.repoRoot);
    } catch (error) {
      console.error(`ERROR: cannot resolve current PR base ref ${baseRef}: ${error.message}`);
      return 1;
    }
    if (base !== eventBase) console.log(`Base ref ${baseRef} advanced from event snapshot ${eventBase.slice(0, 7)} to ${base.slice(0, 7)}; using current base`);
  }
  console.log(`PR #${prNumber}: checking contract and diff (${base.slice(0, 7)}..${head.slice(0, 7)})`);

  const headRuntime = loadRuntime(
    () => loadPolicyRuntime(roots, { label: "repo-policy.json (PR head)" }),
    { label: "repo-policy.json (PR head)", failureMessage: "Proposed policy compilation failed" },
  );
  if (!headRuntime) return 1;
  const headPolicy = headRuntime.policy;
  const initialChecks = [];
  const basePolicyRead = readBasePolicy(base, roots.repoRoot);
  let runtime = headRuntime;
  let basePolicy = null;
  let trustedGovernancePaths = [];

  if (basePolicyRead.error) {
    initialChecks.push({
      name: "governance-trusted-boundary",
      check: {
        ok: false,
        message: `cannot establish trusted governance boundary: ${basePolicyRead.error}`,
        hint: "check-pr requires reading repo-policy.json at the current PR base ref so a PR cannot change the policy that evaluates itself. The boundary is intentionally not falling back to the PR head policy. Ensure the base ref is fetched and repo-policy.json is valid JSON on the base branch.",
        details: [`base_ref: ${base}`, `base_policy_read_error: ${basePolicyRead.error}`],
      },
    });
  } else {
    runtime = loadRuntime(
      () => loadPolicyRuntimeFromObject(roots, basePolicyRead.policy, { label: "repo-policy.json (base)" }),
      { label: "repo-policy.json (base)", failureMessage: "Base policy compilation failed" },
    );
    if (!runtime) return 1;
    basePolicy = runtime.policy;
    trustedGovernancePaths = basePolicy.paths?.governance_paths ?? [];
  }

  const { ajv, policy, contractSchema } = runtime;
  const enforcement = resolveEnforcementMode({ cliValue: roots.enforcementMode, policy });
  if (!enforcement.ok) {
    console.error(`ERROR: ${enforcement.message}`);
    return 1;
  }

  const linked = fetchLinkedIssue({ prBody, repoFullName });
  if (linked.fatal) return 1;
  const { linkedIssues, issueBody } = linked;
  let contractResult = resolvePRContractFacts({ prBody, issueBody });
  if (!contractResult.ok && contractResult.linkedIssues.length === 1 && issueBody === null && contractResult.error !== "issue_link_ambiguous") {
    contractResult = { ...contractResult, error: "issue_fetch_failed", message: `Could not fetch issue #${contractResult.linkedIssues[0]} body` };
  }

  let contract = null;
  let contractSource = contractResult.contractSource || "none";
  const issueAuthorization = contractResult.issueAuthorization || null;
  if (!contractResult.ok) {
    initialChecks.push({ name: "change-contract", check: { ok: false, message: `[${contractResult.error}]: ${contractResult.message}` } });
  } else {
    const candidate = stripPrivilegedSchemaUnknownFields(contractResult.contract);
    const check = validationCheck(ajv, contractSchema, candidate, "change-contract (from markdown)");
    initialChecks.push({ name: "change-contract", check });
    if (check.ok) {
      contract = candidate;
      contractSource = contractResult.contractSource;
      for (const warning of warnReservedContractFields(contract)) console.warn(`WARN: ${warning}`);
    }
  }

  let diffText;
  try {
    diffText = getDiff(base, head, roots.repoRoot);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }

  let trustedAuthorizer = null;
  if (basePolicy && repoFullName) {
    try {
      trustedAuthorizer = resolveTrustedAuthorizer({
        repoFullName,
        issueNumber: linkedIssues.length === 1 ? linkedIssues[0] : null,
        prNumber,
      });
    } catch {
      trustedAuthorizer = null;
    }
  }

  return runPolicyPipeline({
    mode: "check-pr",
    repositoryRoot: roots.repoRoot,
    policy,
    basePolicy,
    headPolicy,
    contract,
    contractSource,
    issueAuthorization,
    trustedGovernancePaths,
    trustedAuthorizer,
    enforcement,
    diffText,
    initialChecks,
  }).exitCode;
}
