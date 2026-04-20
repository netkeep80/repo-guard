# Removing Custom Validators

This guide describes a migration path for downstream repositories that already
carry custom workflow, PR-template, or documentation validators and want to move
those responsibilities into repo-guard.

The goal is not to delete a working validator first. Run repo-guard beside the
existing script in advisory mode, encode the same checks in `repo-policy.json`,
then remove the custom script after `validate-integration` and the PR gate agree.

## Migration Sequence

1. Inventory the custom validator.

   Record each responsibility as a checkable statement:

   - which workflow must run on pull requests;
   - which Action or command is allowed to run the gate;
   - which permissions, token variables, and checkout depth are required;
   - which PR or issue template must contain a change contract;
   - which contract fields are mandatory;
   - which docs must mention policy, profile, or traceability fields.

2. Add repo-guard in advisory mode.

   Keep the existing custom validator active and add a repo-guard workflow based
   on `examples/replace-custom-validator-workflow.yml`. Start with:

   ```yaml
   with:
     mode: check-pr
     enforcement: advisory
   ```

   Run:

   ```bash
   repo-guard --enforcement advisory validate-integration --format summary
   repo-guard doctor --integration --format summary
   ```

3. Express workflow checks in `integration.workflows`.

   A validator that checked "the policy job must run on pull requests with full
   history and a token" maps to:

   ```json
   {
     "id": "repo-guard-pr-gate",
     "kind": "github_actions",
     "path": ".github/workflows/repo-guard.yml",
     "role": "repo_guard_pr_gate",
     "expect": {
       "events": ["pull_request"],
       "event_types": ["opened", "synchronize", "reopened", "ready_for_review"],
       "action": {
         "uses": "netkeep80/repo-guard",
         "ref_pinning": "semver"
       },
       "mode": "check-pr",
       "enforcement": "blocking",
       "permissions": {
         "contents": "read",
         "pull-requests": "read",
         "issues": "read"
       },
       "token_env": ["GH_TOKEN"],
       "summary": true,
       "disallow": ["continue_on_error", "manual_clone", "direct_temp_cli_execution"]
     }
   }
   ```

4. Express template checks in `integration.templates`.

   A validator that parsed `.github/PULL_REQUEST_TEMPLATE.md` to require a
   contract block maps to:

   ```json
   {
     "id": "pull-request-template",
     "kind": "markdown",
     "path": ".github/PULL_REQUEST_TEMPLATE.md",
     "requires_contract_block": true,
     "required_block_kind": "repo-guard-yaml",
     "required_contract_fields": ["change_type", "scope", "anchors.affects"]
   }
   ```

   If linked issues may carry the fallback contract, declare the issue form as
   optional so repositories without that fallback are not forced to add one:

   ```json
   {
     "id": "change-contract-issue-form",
     "kind": "github_issue_form",
     "path": ".github/ISSUE_TEMPLATE/change-contract.yml",
     "requires_contract_block": true,
     "optional": true,
     "required_block_kind": "repo-guard-yaml",
     "required_contract_fields": ["change_type", "scope", "anchors.affects"]
   }
   ```

5. Express documentation checks in `integration.docs`.

   A validator that searched README content for policy and traceability guidance
   maps to:

   ```json
   {
     "id": "readme",
     "kind": "markdown",
     "path": "README.md",
     "must_mention": ["repo-guard", "contract", "integration"],
     "must_reference_files": [
       "repo-policy.json",
       ".github/PULL_REQUEST_TEMPLATE.md",
       ".github/workflows/repo-guard.yml"
     ],
     "must_mention_profiles": ["requirements-strict"],
     "must_mention_contract_fields": ["change_type", "scope", "anchors.affects"],
     "profiles": ["requirements-strict"]
   }
   ```

6. Adopt the `requirements-strict` profile when requirement traceability is part
   of the custom validator.

   Add the built-in profile and narrow the globs to the downstream repository:

   ```json
   {
     "profile": "requirements-strict",
     "profile_overrides": {
       "strict_heading_docs": ["docs/architecture.md", "docs/requirements.md"],
       "evidence_surfaces": ["src/**", "tests/**", "docs/**", ".github/workflows/**"]
     }
   }
   ```

   Then require contributors to include the relevant anchors in the PR contract:

   ```yaml
   anchors:
     affects:
       - FR-014
     implements:
       - FR-014
     verifies:
       - FR-014
   ```

7. Switch repo-guard to blocking.

   After advisory runs are clean, update the workflow input and policy default:

   ```yaml
   with:
     mode: check-pr
     enforcement: blocking
   ```

   ```json
   {
     "enforcement": {
       "mode": "blocking"
     }
   }
   ```

8. Delete the custom validator.

   Remove the old script, its package entry, and its workflow step in the same
   PR that keeps `repo-guard validate-integration --format summary` passing.
   The replacement is complete when:

   - `repo-guard` validates `repo-policy.json`;
   - `repo-guard validate-integration --format summary` passes;
   - `repo-guard doctor --integration --format summary` passes;
   - the PR workflow runs repo-guard in blocking mode.

## Responsibility Map

| Custom validator responsibility | repo-guard replacement |
| --- | --- |
| Enforce the PR workflow trigger | `integration.workflows[].expect.events` and `event_types` |
| Require full checkout history | `repo_guard_pr_gate` workflow diagnostics for `fetch-depth: 0` |
| Require pinned repo-guard Action | `integration.workflows[].expect.action` with `ref_pinning` |
| Require least-privilege permissions | `integration.workflows[].expect.permissions` |
| Require a token for linked issue fallback | `integration.workflows[].expect.token_env` |
| Ban best-effort policy gates | `integration.workflows[].expect.disallow` with `continue_on_error` |
| Ban cloning validator code at runtime | `manual_clone` and `direct_temp_cli_execution` disallowed patterns |
| Require a PR contract block | `integration.templates[].requires_contract_block` |
| Require specific contract fields | `integration.templates[].required_contract_fields` |
| Require policy/profile documentation | `integration.docs[].must_mention` and `must_mention_profiles` |
| Require references to policy files | `integration.docs[].must_reference_files` |
| Enforce requirement traceability | top-level `profile: "requirements-strict"` plus `profile_overrides` |

## Complete Snippets

- `examples/downstream-integration-policy.json` shows a complete downstream
  policy with integration checks and `requirements-strict`.
- `examples/replace-custom-validator-workflow.yml` shows the workflow that can
  replace a custom validation step.
