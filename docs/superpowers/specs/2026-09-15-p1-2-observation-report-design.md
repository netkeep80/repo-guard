# P1.2: единый контекст наблюдения и итоговый структурированный отчёт

Issue: #526

Дата: 2026-09-15

## Цель

Схлопнуть текущую двухпроходную проверку pull request в один процесс оценки, который использует одни и те же неизменяемые наблюдения репозитория, явный конечный план обязательств и один итоговый `AnalysisReport`.

Результат должен быть проще текущей реализации: без второго независимого `runPolicyPipeline`, без повторного чтения одних и тех же байтов, без исполнения заранее исключённых семейств правил и без восстановления машинного результата из консольного текста.

## Исходное состояние

После #524 `check-pr` уже получает точную неизменяемую идентичность наблюдения репозитория: `B`, `M`, `H`, `T`.

После #525 BASE и HEAD policy нормализуются одним каноническим механизмом.

Но `src/github-pr.mts` при изменении policy всё ещё строит два входа и запускает два независимых `runPolicyPipeline`. Каждый проход заново строит policy facts, readers, anchors и diagnostics, после чего итоговый код возврата вычисляется отдельно через максимум двух exit codes.

`src/checks/orchestrator.mts` передаёт исключённые семейства в `RuleRegistry`, но фильтрует их только после `registry.evaluate`, поэтому исключённое семейство всё равно может выполнить свой `evaluate`.

`action.yml` строит команду как строку shell, запускает её через раскрытие строки, а затем восстанавливает `result` и `summary` из человеческого текста через `sed` и `grep`.

Это создаёт три лишние границы истины: два отдельных pipeline report и отдельный shell-parser результата.

## Архитектурное решение

Использовать одну последовательность:

```text
точное наблюдение репозитория
+ нормализованные BASE/HEAD policy
+ ChangeIntent/GovernanceGrant
        ↓
общий immutable ObservationContext
        ↓
конечный EvaluationPlan
        ↓
одна оценка над общими наблюдениями
        ↓
один AnalysisReport
        ↓
text / json / Action outputs
```

Новый общий графовый runtime, новый DSL и новый тип policy не вводятся.

## 1. ObservationContext

Внутри одного `check-pr` создаётся один immutable context с:

- `RepositoryObservation` из #524;
- exact `baseRef` и `headRef`;
- уже полученным diff;
- списком tracked files для `T`;
- `readFile` для evaluated tree;
- `readFileAtRef` для snapshot reads;
- общим byte cache по ключу snapshot identity + path;
- общим document reader поверх того же cache;
- счётчиками чтений только для тестовой/диагностической проверки повторных observation reads.

Policy-independent bytes и базовые факты наблюдаются один раз.

Policy-dependent facts не должны глобально смешиваться между BASE и HEAD. Они вычисляются как view над общим context и кэшируются только по канонической policy/selector identity, если повторное использование доказуемо безопасно.

Минимальная цель P1.2 — устранить повторные неизменяемые reads. Не требуется вводить общий постоянный cache между разными invocations.

## 2. EvaluationPlan

Для каждого `check-pr` до исполнения строится конечный список запланированных оценок.

Если BASE и HEAD policy эквивалентны, план содержит один trusted pass.

Если policy отличается, план содержит:

1. обязательства trusted BASE;
2. дополнительный HEAD veto;
3. явную фазу и `policyOrigin` для каждого элемента плана;
4. заранее исключённые из HEAD veto семейства `governance-paths` и `policy-delta`.

Исключение семейств происходит до вызова `RuleFamily.evaluate`.

`RuleRegistry` должен уметь выбрать применимые family до evaluation по:

- execution phase;
- `applies`;
- exclude set.

Исключённая family не должна иметь наблюдаемых побочных эффектов и не должна выполняться даже в тестовом stub, который бросает исключение.

## 3. Один AnalysisReport

`createAnalysisCollector` остаётся единственной точкой агрегации результата.

BASE и HEAD не создают самостоятельные финальные отчёты. Они добавляют normalized relation results в один collector.

Один итоговый `AnalysisReport` владеет:

- `result`;
- `ok`;
- enforcement mode;
- `exitCode`;
- количеством pass/warning/violation;
- всеми rule results;
- observation identity;
- evaluation plan summary;
- evidence.

`AnalysisReport.result` сохраняет существующие значения `passed`, `passed_with_warnings`, `failed` и получает явное значение `error` для configuration/runtime failure, когда полноценная policy evaluation не может быть завершена. В таком случае report всё равно остаётся единственным машинным результатом команды и несёт стабильный `reasonCode`, безопасное сообщение и `exitCode=1`.

Запрещено вычислять финальный статус отдельным `Math.max(base.exitCode, head.exitCode)` или аналогичной внешней агрегацией.

## 4. Evidence envelope

Каждый rule result получает компактную структурированную evidence envelope там, где соответствующие данные существуют:

```json
{
  "ruleId": "...",
  "policyOrigin": "base|head|shared",
  "relation": "...",
  "operands": ["..."],
  "snapshots": ["..."],
  "ok": true,
  "reasonCode": "stable.machine.code"
}
```

Специализированные payload остаются в `data`, если они уже нужны текущим diagnostics.

Evidence не должна включать:

- токены;
- секреты;
- полное тело issue;
- полное тело PR;
- произвольные environment variables.

Для authorization допускаются только source/provenance identifiers, author/trust outcome и covered paths/pointers либо другие компактные ссылки, уже необходимые для доказательства решения.

## 5. Structured output `check-pr`

`check-pr` получает существующий для `check-diff` принцип выбора renderer:

```text
repo-guard check-pr --format text
repo-guard check-pr --format json
repo-guard check-pr --format summary
```

`text` остаётся значением по умолчанию.

`json` печатает ровно один сериализованный итоговый `AnalysisReport` в stdout. Human diagnostics в этом режиме не смешиваются с JSON.

Отдельный CLI-флаг `--output` не вводится: для Action и других машинных consumers достаточно обычного перенаправления stdout в файл. Это уменьшает публичную CLI-поверхность и использует уже существующий renderer contract.

Код возврата процесса берётся только из `AnalysisReport.exitCode`.

## 6. Контракт Action

Текущий публичный output vocabulary сохраняется:

- `passed` — AnalysisReport имеет `result=passed` или `result=passed_with_warnings`;
- `failed` — AnalysisReport имеет `result=failed`, включая advisory policy violations;
- `error` — AnalysisReport имеет `result=error` из-за configuration/runtime failure.

Отображение внутреннего report vocabulary в Action output фиксировано и не зависит от текста diagnostics:

```text
passed              -> passed
passed_with_warnings -> passed
failed              -> failed
error               -> error
```

Для advisory policy violation:

```text
AnalysisReport.result = failed
Action result = failed
exitCode = 0
```

Для blocking policy violation:

```text
AnalysisReport.result = failed
Action result = failed
exitCode = 1
```

Для configuration/runtime error:

```text
AnalysisReport.result = error
Action result = error
exitCode = 1
```

`action.yml` больше не должен определять semantic result самостоятельно.

Он должен:

1. получать composite-action inputs через `env`, чтобы `${{ inputs.* }}` не попадали непосредственно в исполняемый shell syntax;
2. собирать argv как bash array с отдельным элементом на каждое значение;
3. вызвать `check-pr`/`check-diff` с `--format json` и перенаправить stdout в временный report file;
4. прочитать JSON небольшим Node-вызовом;
5. применить только фиксированное отображение `AnalysisReport.result -> Action result` выше;
6. сформировать `summary` из структурированных counters/reason, не из prose parsing;
7. перенести `result` и `summary` в `$GITHUB_OUTPUT`;
8. завершиться тем же exit code, который вернул repo-guard.

Запрещаются:

- `CMD="$CMD ..."` как механизм сборки исполняемой команды;
- исполнение untrusted inputs через shell syntax;
- `sed`/`grep` для определения результата;
- печать `GH_TOKEN` либо других секретов.

Пути с пробелами и shell metacharacters должны передаваться буквально.

## 7. Изменения по файлам

Ожидаемые production edit-sites:

- `src/github-pr.mts` — один orchestration flow, один report;
- `src/runtime/pipeline.mts` — оценка в существующий collector/context вместо обязательного создания собственного final report;
- `src/runtime/analysis-report.mts` — финальный report contract, `error` outcome и evidence metadata;
- `src/facts/input.mts` — принятие общего immutable observation/read context;
- `src/checks/rule-registry.mts` — pre-evaluation family selection;
- `src/checks/orchestrator.mts` — упрощение после переноса фильтрации;
- `src/repo-guard.mts` — `--format` для `check-pr`;
- `action.yml` — argv-safe запуск и JSON consumption;
- соответствующий generated `dist/**`.

Новые production files допускаются только если они уменьшают суммарную сложность и позволяют удалить больше дублирования, чем добавляют. Предпочтение — использовать существующие boundaries.

`repo-policy.json`, `schemas/**` и `.github/workflows/**` не меняются.

## 8. Инвариант упрощения

Так как изменение имеет тип `refactor`, self-policy repo-guard должна пройти без GovernanceGrant и без расширения diff budget.

Цель по production source:

```text
src/** net added lines <= 0
```

Если реализация требует положительного роста production source, сначала необходимо упростить дизайн, а не расширять trusted budget.

## 9. TDD-доказательства

До production-кода создаётся RED corpus P1.2.

Обязательные случаи:

1. `BASE FAIL + HEAD PASS` → финальный `AnalysisReport.result=failed`, blocking `exitCode=1`;
2. `BASE PASS + HEAD FAIL` → финальный `AnalysisReport.result=failed`, blocking `exitCode=1`;
3. advisory violation → `AnalysisReport.result=failed`, Action `result=failed`, `exitCode=0`;
4. warning без violation → `AnalysisReport.result=passed_with_warnings`, Action `result=passed`;
5. configuration/runtime failure → `AnalysisReport.result=error`, Action `result=error`;
6. missing BASE file;
7. wrong scalar type;
8. invalid pointer;
9. pin mismatch;
10. path с пробелами;
11. filename с shell metacharacters;
12. throwing excluded family → исключение не возникает, потому что family не исполняется;
13. read counters → один immutable file/snapshot read для одинакового ключа внутри invocation;
14. token marker, полный issue body и полный PR body отсутствуют в serialized report;
15. observation `B/M/H/T` присутствует в итоговом report;
16. existing P0.4 state-obligation replacement semantics не изменились;
17. `check-pr --format json` пишет только JSON в stdout и согласованный diagnostics stream в stderr;
18. текущий `check-diff --format json` contract остаётся совместимым.

После GREEN локального corpus обязательны:

- полный discovered test suite;
- `check:dist`;
- self `check-pr`;
- `validate`;
- `smoke-pack`;
- dedicated `trusted-enforcement` на exact PR head;
- реальный composite Action smoke с path containing spaces и literal shell metacharacters;
- post-merge CI на exact merge commit.

## 10. Совместимость

Human-readable CLI текст может стать проще, но machine semantics не должны зависеть от текста.

Публичные Action outputs `result` и `summary` сохраняются.

Существующий `check-diff --format json` envelope не ломается.

Существующий `AnalysisReport` contract расширяется совместимо. Удаление или переименование существующего публичного поля допускается только при отдельном доказательстве, что оно не является поддерживаемым contract.

Никакие accidental `sed/grep` parser quirks не считаются контрактом.

## 11. Не-цели

В #526 не входят:

- новый policy DSL;
- новый graph evaluator;
- постоянный cross-run cache;
- изменение branch protection;
- изменение схем policy;
- изменение trusted-enforcement topology;
- consumer-specific bypass;
- расширение GovernanceGrant для обхода self-policy;
- новый общий transport/protocol layer между CLI и Action.

## Критерий завершения

#526 считается принятой только если одновременно доказано:

- `check-pr` создаёт один финальный `AnalysisReport`;
- `AnalysisReport` единолично определяет exit semantics;
- BASE/HEAD используют один immutable observation context;
- excluded families не исполняются;
- duplicate immutable reads устранены для одинакового observation key;
- `check-pr --format json` является machine authority для Action;
- Action не строит одну interpolated shell command и не парсит prose;
- секреты и полные issue/PR bodies не попадают в report;
- self-policy принимает refactor без GovernanceGrant;
- exact-head и post-merge gates GREEN.
