# Downstream Repo

This downstream repository uses repo-guard for contract based integration
checks. The repo-policy.json file declares how .github/workflows/repo-guard.yml
runs the PR gate and how .github/PULL_REQUEST_TEMPLATE.md carries the contract.

Contract fields documented for contributors: change_type, scope, and
anchors.affects.

Profile id: requirements-strict
Migration target: requirements-strict
