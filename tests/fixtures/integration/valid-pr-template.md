## Summary

Describe the intended change.

## Change Contract

```repo-guard-yaml
change_type: feature
scope:
  - src/**
anchors:
  affects:
    - FR-014
must_touch:
  - tests/**
must_not_touch: []
expected_effects:
  - The change is covered by repo-guard integration checks.
```
