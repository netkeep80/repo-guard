# Portfolio roadmap

`repo-guard` является частью portfolio [`netkeep80`](https://github.com/netkeep80).

Portfolio-level направление, приоритет, lifecycle, cross-repo dependencies и следующий gate **намеренно не дублируются здесь**. Authoritative sources:

- [netkeep80/roadmap](https://github.com/netkeep80/roadmap) — главный portfolio control plane;
- [Current status](https://github.com/netkeep80/roadmap/blob/main/STATUS.md) — live GitHub state;
- [Execution order](https://github.com/netkeep80/roadmap/blob/main/EXECUTION.md) — cross-repo gates;
- [Architecture](https://github.com/netkeep80/roadmap/blob/main/ARCHITECTURE.md) — canonical ownership/dependencies.

repo-guard issues, policy engine code, tests и consumer-specific rollout details остаются local implementation source of truth.

```text
roadmap decides portfolio direction;
this repository owns the governance engine implementation;
GitHub facts feed the central live status.
```

Consumer-driven portfolio priority меняется только в central roadmap.
