# P1.2: план реализации единого observation/report path

> Для агентной реализации: выполнять задачи последовательно через TDD. Production-код не менять до подтверждённого RED для соответствующего поведения.

**Цель:** заменить двойной BASE/HEAD pipeline и shell-parsing Action на один immutable observation context, конечный evaluation plan и один итоговый `AnalysisReport`.

**Архитектура:** `check-pr` строит один набор неизменяемых наблюдений и один collector, затем выполняет один или два policy-origin шага (`base`, `head`) поверх общего context. Rule family исключаются до `evaluate`; финальный report единолично задаёт machine result и exit semantics. `action.yml` только передаёт argv безопасно и читает JSON.

**Стек:** TypeScript/ESM, Node.js >=20, встроенный `node:test`, GitHub composite Action, generated `dist/**`.

**Спецификация:** `docs/superpowers/specs/2026-09-15-p1-2-observation-report-design.md`.

## Глобальные ограничения

- Рабочая задача: #526; рабочий PR: #551; новых issues не создавать.
- GitHub остаётся единственным source of truth.
- Документация и поясняющие комментарии — по-русски, кроме имён API, методов, кодов и машинных идентификаторов.
- `repo-policy.json`, `schemas/**`, `.github/workflows/**` не изменять.
- `change_type=refactor`; итоговый `src/**` должен иметь `net added lines <= 0`; GovernanceGrant для обхода этого ограничения запрещён.
- Существующий `check-diff --format json` envelope не ломать.
- Публичный Action `result` остаётся `passed|failed|error`; `AnalysisReport.result=passed_with_warnings` отображается в Action `passed`.
- Точный observation contract B/M/H/T из #524 и scoped state-obligation semantics из #522 должны сохраниться.
- Generated `dist/**` меняется только как результат сборки принятого `src/**`.

---

### Задача 1: RED corpus для P1.2

**Файлы:**
- Создать: `tests/test-p1-2-observation-report.mjs`
- При необходимости расширить только test support: `tests/support/**`

**Интерфейсы:**
- Использует текущий `dist/repo-guard.mjs` и существующие test helpers.
- Формирует требования для следующих задач без изменения production-кода.

- [ ] Добавить fixture PR с различающимися BASE/HEAD policy и `--format json`.
- [ ] Зафиксировать RED `BASE FAIL + HEAD PASS`: текущая реализация не выдаёт единый JSON report с финальным failed outcome.
- [ ] Зафиксировать RED `BASE PASS + HEAD FAIL`.
- [ ] Зафиксировать RED на `check-pr --format json`, потому что CLI пока не принимает `--format` для `check-pr`.
- [ ] Добавить structural RED, что excluded family, бросающая исключение в `evaluate`, не должна выполняться.
- [ ] Добавить read-counter RED: одинаковый immutable `(snapshot,path)` внутри одного PR invocation должен читаться один раз.
- [ ] Добавить отсутствие token marker, полного issue body и полного PR body в serialized report.
- [ ] Добавить presence B/M/H/T в JSON report.
- [ ] Добавить regression cases для P0.4 state-obligation replacement.
- [ ] Добавить structural Action assertions: нет `CMD="$CMD`, нет `sed`/`grep` decision parsing; inputs передаются через env/argv-array.
- [ ] Добавить path-with-spaces и literal shell-metacharacters fixture.
- [ ] Запустить `node tests/test-p1-2-observation-report.mjs`; ожидается FAIL именно по отсутствующей P1.2 semantics, а не syntax/setup error.
- [ ] Зафиксировать RED отдельным commit до production-изменений.

### Задача 2: исключать family до evaluation

**Файлы:**
- Изменить: `src/checks/rule-registry.mts`
- Упростить: `src/checks/orchestrator.mts`
- Generated после GREEN: `dist/checks/rule-registry.mjs`, `dist/checks/orchestrator.mjs`
- Тест: `tests/test-p1-2-observation-report.mjs`

**Интерфейсы:**
- `RuleRegistry.evaluate(facts, context)` продолжает возвращать `NormalizedRuleEntry[]`.
- `context.excludeFamilies` становится входом selection stage и проверяется до `family.applies`/`family.evaluate`.

- [ ] Убедиться, что RED test действительно падает из-за вызова throwing excluded family.
- [ ] В `RuleRegistry.evaluate` построить `excludedFamilies = new Set(context.excludeFamilies || [])` и вернуть `[]` до `applies/evaluate` для исключённого `family.id`.
- [ ] Удалить post-evaluation filtering из `runPolicyChecks`.
- [ ] Запустить focused test; ожидается GREEN.
- [ ] Запустить `node tests/test-rule-registry.mjs` и `node tests/test-execution-phases.mjs`; ожидается GREEN.
- [ ] Сравнить source LOC: эта задача не должна давать положительный net growth `src/**`.

### Задача 3: один collector и конечный EvaluationPlan

**Файлы:**
- Изменить/сжать: `src/runtime/pipeline.mts`
- Изменить/сжать: `src/github-pr.mts`
- Изменить: `src/runtime/analysis-report.mts`
- Generated: соответствующие `dist/**`
- Тест: `tests/test-p1-2-observation-report.mjs`, существующие `tests/test-pipeline.mjs`, `tests/test-github-pr.mjs`, `tests/test-analysis-report-boundary.mjs`

**Интерфейсы:**
- Один `createAnalysisCollector(enforcement)` создаётся на весь `check-pr`.
- Pipeline evaluation должна уметь добавлять результаты в переданный collector без самостоятельного `finish()`.
- Один PR plan состоит из элементов вида `{ policyOrigin: "base"|"head", input, options }`.
- `policyOrigin` передаётся в normalized rule result/evidence.
- Только orchestration завершает collector один раз и получает `AnalysisReport.exitCode`.

- [ ] Подтвердить RED `BASE FAIL + HEAD PASS` и `BASE PASS + HEAD FAIL` на одном report.
- [ ] Выделить в `pipeline.mts` evaluation body, который принимает reporter/collector извне; сохранить single-pass wrapper для `check-diff` без дублирования semantics.
- [ ] В `github-pr.mts` заменить `baseResult`, `proposedResult`, `Math.max(...)` на конечный plan из одного либо двух шагов.
- [ ] HEAD veto сохраняет `excludeFamilies=["governance-paths","policy-delta"]`; exclusion теперь происходит до evaluation.
- [ ] В одном collector проставлять origin metadata: ordinary unchanged policy — `shared` либо `base` согласно spec; изменённая policy — `base` и `head`.
- [ ] В `analysis-report.mts` добавить compact evidence fields без копирования полного inputs: `ruleId`, `policyOrigin`, `relation`/operand identities/snapshots если уже есть в `data`, `ok`, стабильный `reasonCode`.
- [ ] `reasonCode` выводить детерминированно из machine rule/outcome, не из prose message.
- [ ] Добавить `result="error"` path для pre-evaluation runtime/configuration failure, который всё равно формирует один machine report с `exitCode=1`.
- [ ] Запустить focused P1.2 tests, затем pipeline/github-pr/analysis-report suites; ожидается GREEN.
- [ ] Удалить ставшие ненужными локальные типы/helpers из `github-pr.mts`, чтобы суммарный `src/**` не рос.

### Задача 4: общий invocation-local observation reader

**Файлы:**
- Изменить/сжать: `src/facts/input.mts`
- Изменить: `src/github-pr.mts`
- Generated: `dist/facts/input.mjs`, `dist/github-pr.mjs`
- Тест: `tests/test-p1-2-observation-report.mjs`, `tests/test-p0-6-exact-repository-observation.mjs`

**Интерфейсы:**
- `RepositoryFactsInput` принимает optional shared observation-read context либо уже memoized `readFile/readFileAtRef` closures.
- Cache identity только invocation-local и включает immutable snapshot identity + normalized path.
- Разные SHA для одного path не совпадают.

- [ ] Подтвердить RED read-counter fixture.
- [ ] Создать один memoized byte reader в PR orchestration или существующей facts boundary; не вводить persistent/global cache.
- [ ] `readEvaluatedFile` и `readSnapshotFile` используют общий key space с точным SHA/tree identity.
- [ ] Оба policy-origin шага получают те же read closures/context.
- [ ] Не переносить в #526 parsed-document cross-relation cache из #531; здесь только устранение повторных одинаковых immutable reads между плановыми проходами.
- [ ] Запустить counter fixture: один key → один underlying read; same path/different SHA → два read.
- [ ] Запустить P0.6 suite; B/M/H/T и dirty/stale fail-closed semantics должны остаться GREEN.

### Задача 5: structured `check-pr` без нового transport layer

**Файлы:**
- Изменить: `src/repo-guard.mts`
- Изменить/сжать: `src/github-pr.mts`
- Использовать существующий: `src/reporting/renderers.mts`
- Generated: `dist/repo-guard.mjs`, `dist/github-pr.mjs`
- Тест: `tests/test-p1-2-observation-report.mjs`, `tests/test-structured-output.mjs`, `tests/test-cli-runtime.mjs`

**Интерфейсы:**
- `check-pr --format text|json|summary`; default `text`.
- `json` stdout содержит ровно один serialized `AnalysisReport`.
- Diagnostics, которые нельзя включить в report до его формирования, идут в stderr; stdout JSON не загрязняется.
- Process exit = `report.exitCode`.

- [ ] Подтвердить RED CLI parser на `check-pr --format json`.
- [ ] Разрешить `--format` в `COMMAND_SPECS["check-pr"]`.
- [ ] Передать format в `runCheckPR`, как уже делает `check-diff`.
- [ ] Для `json/summary` запускать pipeline quiet и render через существующий `renderAnalysisReport`.
- [ ] Не добавлять `--output`.
- [ ] Проверить валидный JSON stdout, B/M/H/T, evaluation plan, policyOrigin/reasonCode и отсутствие secret/full-body markers.
- [ ] Запустить существующий `test-structured-output.mjs`; envelope `check-diff` должен остаться совместимым.

### Задача 6: Action становится тонким JSON adapter

**Файлы:**
- Изменить/сжать: `action.yml`
- Тест: `tests/test-p1-2-observation-report.mjs` и/или отдельный focused Action contract test только если это уменьшает setup duplication.

**Интерфейсы:**
- Inputs попадают в step `env`, затем в bash array `ARGS=(...)` отдельными argv элементами.
- CLI вызывается как `node "$GITHUB_ACTION_PATH/dist/repo-guard.mjs" ... --format json`.
- stdout перенаправляется в `mktemp` report file.
- Маленький `node -e` читает JSON и печатает только подготовленные output lines/summary data.
- Action mapping: `passed|passed_with_warnings -> passed`, `failed -> failed`, `error -> error`.
- Step возвращает исходный CLI exit code.

- [ ] Подтвердить structural RED на текущем `CMD="$CMD`, `sed`, `grep`.
- [ ] Перенести `${{ inputs.* }}` только в `env:` значения step, не в shell code.
- [ ] Собрать argv-array с условными элементами для `check-diff` inputs.
- [ ] Вызвать CLI с `--format json`, сохранить `$?`, затем прочитать report file.
- [ ] Формировать `summary` из `passed`, `violationCount`, `warnings`, `result/reasonCode`, а не из human prose.
- [ ] Всегда удалять temp file; `GH_TOKEN` не печатать.
- [ ] Test path с пробелами и literal `; $() * ?` проходит как данные и не выполняется shell.
- [ ] Advisory violation: Action output `failed`, step exit `0`; warning-only: Action output `passed`, exit `0`; blocking/error: exit `1`.

### Задача 7: generated dist и компрессия

**Файлы:**
- Generated: все изменившиеся `dist/**`
- Никаких других production surfaces.

- [ ] Выполнить сборку `npm run build` на exact source state.
- [ ] Выполнить `npm run check:dist`; ожидается GREEN.
- [ ] Выполнить `npm run compression:metrics` и сравнить source growth относительно PR base.
- [ ] Если `src/** net added lines > 0`, не ослаблять policy: удалить duplication/лишние abstractions до `<=0`.
- [ ] Проверить, что `repo-policy.json`, `schemas/**`, `.github/workflows/**` не изменились.

### Задача 8: полный acceptance цикл

**Файлы:** нет новых; только evidence в #526/#551 после успешных проверок.

- [ ] `npm test` — весь discovered corpus GREEN.
- [ ] `npm run check:dist` — GREEN.
- [ ] `node dist/repo-guard.mjs` — self validate GREEN.
- [ ] Draft PR exact-head CI: `validate` и `smoke-pack` GREEN.
- [ ] Реальный composite Action smoke на exact head, включая path with spaces/metacharacters.
- [ ] Перевести #551 из draft только после полного GREEN.
- [ ] Dedicated App `trusted-enforcement` на том же exact head должен быть `success`; отдельно проверить App id `4951752`.
- [ ] Перед merge повторно проверить main SHA, package 3.1.0, #526/#551, branch protection, workflows, repo-policy и changed-file scope.
- [ ] Merge только с `expected_head_sha` проверенного exact head.
- [ ] Подтвердить новый exact `main`, auto-close #526 и post-merge `validate`/`smoke-pack` GREEN на merge commit.
- [ ] Записать acceptance evidence в #526 и parent #518; новых issues не создавать.

## Самопроверка плана

- Все acceptance пункты design-spec покрыты задачами 1–8.
- Новый policy DSL, graph evaluator, persistent cache, `--output`, schema/workflow изменения не вводятся.
- TDD порядок соблюдён: первый code-related commit — только RED tests; каждое production поведение реализуется после наблюдаемого RED.
- Наиболее рискованные границы — final outcome, pre-evaluation exclusion, shared reads и Action shell safety — имеют отдельные falsifiers.
- Главный критерий простоты измерим: удаляется второй final pipeline/report path и shell prose protocol, а `src/**` не растёт.
