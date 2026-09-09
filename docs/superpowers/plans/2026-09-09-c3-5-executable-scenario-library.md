# C3.5 — план реализации исполняемой библиотеки сценариев

> **Для агентных исполнителей:** обязательный поднавык — `superpowers:subagent-driven-development` или `superpowers:executing-plans`. Выполнять задачи последовательно по чекбоксам `- [ ]`; следующий срез не начинается до принятия предыдущего в `main`.

**Цель:** создать один маленький корпус `examples/scenarios/**`, который одновременно является исполняемым регрессионным доказательством, человеческим примером и будущим источником данных для C3.6.

**Архитектура:** сценарии являются только данными. Один тестовый исполнитель создаёт реальные временные репозитории `Git` с `BASE` и `HEAD` и запускает настоящий `dist/repo-guard.mjs`. Семантика политики остаётся только в рабочем `repo-guard`; тестовая инфраструктура проверяет материализацию, код завершения и ограниченный набор стабильных идентификаторов диагностик.

**Стек:** `Node.js 24`, встроенные `node:test`, `node:assert`, `node:fs`, `node:path`, `node:os`, `node:child_process`, `Git CLI` и существующий `dist/repo-guard.mjs`.

**Спека:** `docs/superpowers/specs/2026-09-09-c3-5-executable-scenario-library-design.md`

**Последовательность:** #428 → #429 → #430 → #431; родитель #376; дорожная карта #370.

## Неподвижные границы

```text
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
canonical evaluator = 1
scenario production concepts = 0

NO src/**
NO dist/**
NO schemas/**
NO action.yml
NO .github/workflows/**
NO new runtime kind
NO new FactRef source
NO new relation descriptor
NO scenario policy DSL
NO test-only semantic evaluator
NO workflow/integration runtime revival
NO parallel/control-plane revival
NO C3.6 work inside C3.5
```

Если любой срез требует изменения запрещённой рабочей поверхности, выполнение останавливается. Требование оформляется как отдельный архитектурный разрыв, а не как разрешение расширить C3.5.

## Общая форма корпуса

```text
examples/scenarios/<scenario>/
  scenario.json
  base/
    repo-policy.json
    <минимальные файлы>
  cases/
    <case>/
      head/
        <наложение поверх base>
```

Разрешённые дополнительные входы:

```text
change-intent.json
pr-body.md
issue-body.md
```

Они не входят в проверяемый переход и копируются либо читаются после фиксации `HEAD`.

Единственный исполнитель:

```text
tests/test-c3-5-scenario-library.mjs
```

Он отвечает только за:

```text
обнаружение каталогов
проверку технической формы scenario.json
копирование base/**
создание commit BASE
наложение head/**
удаление delete_paths
создание commit HEAD
подготовку дополнительных входов
запуск настоящего CLI
проверку exit code
проверку обязательных diagnostic ids
```

Он не вычисляет правила политики самостоятельно.

---

## Задача 1 — C3.5a: форма корпуса и `minimal-diff-policy`

**GitHub-задача:** #428

**Разрешённые файлы:**

```text
tests/test-c3-5-scenario-library.mjs
examples/scenarios/README.md
examples/scenarios/minimal-diff-policy/**
```

### 1.1. Первый commit — только красная проверка

- [ ] Создать только `tests/test-c3-5-scenario-library.mjs`.

Начальная проверка:

```js
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenariosRoot = resolve(root, "examples/scenarios");

assert.ok(existsSync(scenariosRoot), "C3.5a: каталог examples/scenarios ещё не создан");
const ids = readdirSync(scenariosRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(ids.includes("minimal-diff-policy"), "C3.5a: отсутствует minimal-diff-policy");
```

- [ ] Создать черновой PR с `Fixes #428` и доказать ожидаемый красный результат.
- [ ] До нового теста должны оставаться зелёными `check:dist`, `compression:metrics`, проверка собственной политики, `doctor` и старые тесты.

### 1.2. Общий исполнитель

- [ ] В том же тестовом файле добавить обнаружение без списка имён сценариев:

```js
function discoverScenarios() {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(resolve(scenariosRoot, entry.name, "scenario.json")))
    .map((entry) => entry.name)
    .sort();
}
```

- [ ] Проверять только технические поля верхнего уровня:

```text
id
title_ru
summary_ru
command
cases
```

- [ ] Для элемента `cases[]` разрешить только:

```text
id
title_ru
expected_exit_code
expected_diagnostics
delete_paths
change_intent
pr_body
issue_body
```

- [ ] Требовать совпадение `id` с именем каталога, кириллицу в `title_ru` и `summary_ru`, непустой список вариантов и команду из конечного набора `check-diff | check-pr`.
- [ ] Не создавать отдельную схему продукта для `scenario.json`.

### 1.3. Материализация перехода

- [ ] Добавить общие функции копирования и команд `Git`:

```js
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf-8",
  stdio: "pipe",
}).trim();

function copyTree(source, target) {
  cpSync(source, target, { recursive: true });
}
```

- [ ] Для каждого варианта создавать реальный временный репозиторий:

```js
const temp = mkdtempSync(join(tmpdir(), "repo-guard-scenario-"));
copyTree(resolve(scenarioRoot, "base"), temp);
git(temp, "init", "-b", "main");
git(temp, "config", "user.email", "scenario@test.invalid");
git(temp, "config", "user.name", "repo-guard scenario");
git(temp, "add", "-A");
git(temp, "commit", "-m", "BASE");
const base = git(temp, "rev-parse", "HEAD");
copyTree(resolve(caseRoot, "head"), temp);
for (const path of testCase.delete_paths || []) {
  rmSync(resolve(temp, path), { recursive: true, force: true });
}
git(temp, "add", "-A");
git(temp, "commit", "-m", "HEAD");
const head = git(temp, "rev-parse", "HEAD");
```

Каталог `head/` обязателен. Пустой переход не поддерживать.

- [ ] Если указан `change_intent`, копировать его во временный каталог после фиксации `HEAD`, чтобы служебный вход не попадал в проверяемый переход.

### 1.4. Настоящий `check-diff`

- [ ] Запускать процесс:

```js
const args = [
  cli,
  "--repo-root", temp,
  "check-diff",
  "--base", base,
  "--head", head,
  "--format", "json",
];
if (testCase.change_intent) {
  args.push("--change-intent", ".scenario-change-intent.json");
}
const result = spawnSync(process.execPath, args, {
  cwd: temp,
  encoding: "utf-8",
  env: process.env,
});
```

- [ ] Разбирать только публичный `AnalysisReport`:

```js
const report = JSON.parse(result.stdout);
assert.equal(result.status, testCase.expected_exit_code);
assert.equal(report.exitCode, testCase.expected_exit_code);
const actual = report.violations.map((item) => item.rule).sort();
for (const expected of testCase.expected_diagnostics) {
  assert.ok(actual.includes(expected));
}
if (testCase.expected_exit_code === 0) assert.deepEqual(report.violations, []);
```

Для отрицательного варианта `expected_diagnostics` — обязательное подмножество, а не снимок всего отчёта.

### 1.5. Первый сценарий

- [ ] Создать `scenario.json`:

```json
{
  "id": "minimal-diff-policy",
  "title_ru": "Минимальная политика изменения",
  "summary_ru": "Показывает глобальный запрет пути и простой предел изменения.",
  "command": "check-diff",
  "cases": [
    {
      "id": "pass",
      "title_ru": "Обычное изменение разрешено",
      "expected_exit_code": 0,
      "expected_diagnostics": []
    },
    {
      "id": "fail-forbidden",
      "title_ru": "Запрещённый путь блокируется",
      "expected_exit_code": 1,
      "expected_diagnostics": ["forbidden-paths"]
    }
  ]
}
```

- [ ] Базовая `repo-policy.json`:

```json
{
  "policy_format_version": "0.3.0",
  "repository_kind": "application",
  "enforcement": { "mode": "blocking" },
  "paths": {
    "forbidden": ["forbidden.txt"],
    "canonical_docs": [],
    "governance_paths": ["repo-policy.json"]
  },
  "diff_rules": {
    "max_new_docs": 1,
    "max_new_files": 2,
    "max_net_added_lines": 20
  },
  "content_rules": [],
  "cochange_rules": []
}
```

- [ ] Создать файлы:

```text
base/src/app.txt
cases/pass/head/src/app.txt
cases/fail-forbidden/head/forbidden.txt
```

- [ ] `examples/scenarios/README.md` описывает только общую форму корпуса и правило «данные → реальный репозиторий → рабочая команда»; содержимое конкретных политик не копируется.

### 1.6. Приёмка #428

- [ ] Выполнить:

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
node dist/repo-guard.mjs
```

- [ ] После зелёного чернового PR перевести его в `Ready`.
- [ ] На неизменном `SHA` получить успешные `validate`, `smoke-pack` и `Run PR policy check`.
- [ ] Слить именно проверенный `SHA` и дождаться успешных `validate + smoke-pack` после слияния.
- [ ] Убедиться, что #428 закрылась `completed`.

---

## Задача 2 — C3.5b: `surgical-change` и `version-transition`

**GitHub-задача:** #429. Начинать только после принятия #428.

### 2.1. Красная проверка

- [ ] Первый commit меняет только общий тест:

```js
for (const required of [
  "minimal-diff-policy",
  "surgical-change",
  "version-transition",
]) {
  assert.ok(discovered.includes(required), `C3.5b: отсутствует ${required}`);
}
```

Принятый `minimal-diff-policy` должен пройти до ошибки об отсутствующем новом сценарии.

### 2.2. `surgical-change`

- [ ] Добавить manifest:

```json
{
  "id": "surgical-change",
  "title_ru": "Точное ограничение транзакции",
  "summary_ru": "Показывает область изменения, обязательный и запрещённый пути и бюджет ChangeIntent.",
  "command": "check-diff",
  "cases": [
    {
      "id": "pass",
      "title_ru": "Заявленная транзакция соблюдена",
      "expected_exit_code": 0,
      "expected_diagnostics": [],
      "change_intent": "change-intent.json"
    },
    {
      "id": "fail-must-not-touch",
      "title_ru": "Запрещённый транзакцией документ изменён",
      "expected_exit_code": 1,
      "expected_diagnostics": ["must-not-touch"],
      "change_intent": "change-intent.json"
    }
  ]
}
```

- [ ] Общий вход `change-intent.json`:

```json
{
  "change_type": "feature",
  "scope": ["src/**", "docs/**"],
  "budgets": { "max_new_files": 3, "max_net_added_lines": 20 },
  "anchors": { "affects": [], "implements": [], "verifies": [] },
  "must_touch": ["src/**"],
  "must_not_touch": ["docs/**"],
  "expected_effects": ["Точное изменение исходного файла"]
}
```

- [ ] Положительный вариант меняет только `src/app.txt`.
- [ ] Отрицательный вариант меняет `src/app.txt` и добавляет `docs/oops.md`; область и обязательный путь остаются допустимыми, а нарушение локализуется в `must-not-touch`.

### 2.3. `version-transition`

- [ ] Добавить описание с положительным переходом `1.2.3 → 1.2.4` и отрицательным `1.2.3 → 1.2.2`; ожидаемый идентификатор — `document-relation:release-revision`.

- [ ] В базовой policy использовать уже принятую связь:

```json
"document_relations": {
  "documents": {
    "base-revision": { "path": "meta/REVISION", "format": "plain_text", "snapshot": "base" },
    "head-revision": { "path": "meta/REVISION", "format": "plain_text", "snapshot": "head" }
  },
  "rules": [
    {
      "id": "release-revision",
      "kind": "scalar_strictly_greater",
      "comparator": "semver",
      "left": { "document": "head-revision", "pointer": "", "type": "string" },
      "right": { "document": "base-revision", "pointer": "", "type": "string" }
    }
  ]
}
```

- [ ] Файлы версии:

```text
base/meta/REVISION                      = 1.2.3
cases/pass/head/meta/REVISION           = 1.2.4
cases/fail-downgrade/head/meta/REVISION = 1.2.2
```

### 2.4. Приёмка #429

- [ ] Общий исполнитель не получает ветвления по `manifest.id`.
- [ ] Любое изменение исполнителя допускается только после доказанного общего дефекта.
- [ ] Выполнить новый тест, `npm test`, `check:dist`, метрики и обычный self-check.
- [ ] Черновая проверка успешна → `Ready` на точной голове успешно → слияние точной головы → проверки после слияния успешны.

---

## Задача 3 — C3.5c: `contract-evidence`

**GitHub-задача:** #430. Начинать только после принятия #429.

### 3.1. Красная проверка

- [ ] Первый commit меняет только общий тест:

```js
assert.ok(
  discovered.includes("contract-evidence"),
  "C3.5c: отсутствует contract-evidence",
);
```

Все ранее принятые сценарии должны оставаться зелёными.

### 3.2. Базовая политика

- [ ] Использовать существующий `contract_conformance` без нового механизма:

```json
"contract_conformance": {
  "current": {
    "contract": { "path": "contracts/spec.json", "format": "json" },
    "conformance": { "path": "contracts/checks.yaml", "format": "yaml" }
  },
  "pair_fields": {
    "contract_id": "/schema",
    "conformance_contract_id": "/contract",
    "contract_conformance_path": "/conformanceCorpus",
    "contract_status": "/status",
    "conformance_status": "/status",
    "contract_accepted": "/accepted",
    "conformance_accepted": "/accepted"
  },
  "accepted_state": { "status": "accepted", "accepted": true },
  "required_paths": [
    { "document": "current.contract", "pointer": "/owners", "projection": "object_values" },
    { "document": "current.conformance", "pointer": "/requiredGates", "projection": "array_items" }
  ],
  "cochange": ["current.contract", "current.conformance"],
  "control_paths": ["contracts/**"]
}
```

`paths.governance_paths` включает `repo-policy.json` и `contracts/**`.

### 3.3. Базовые документы

- [ ] `contracts/spec.json`:

```json
{
  "schema": "spec-v1",
  "status": "accepted",
  "accepted": true,
  "conformanceCorpus": "contracts/checks.yaml",
  "owners": { "spec": "docs/spec.md" }
}
```

- [ ] `contracts/checks.yaml`:

```yaml
contract: spec-v1
status: accepted
accepted: true
requiredGates:
  - tests/gate.mjs
```

- [ ] Создать `docs/spec.md` и `tests/gate.mjs`.

### 3.4. Положительный и отрицательный варианты

- [ ] Положительный `HEAD` меняет оба документа вместе и сохраняет все связи; можно добавить нейтральное поле `revision: 2` в оба документа.
- [ ] Положительный вариант ожидает код `0` и отсутствие нарушений.
- [ ] Отрицательный вариант меняет оба документа так же, но имеет:

```json
"delete_paths": ["tests/gate.mjs"]
```

- [ ] Ожидаемый идентификатор нарушения:

```text
document-relation:contract-conformance:required-path:1
```

Если живой рабочий код выдаёт иной идентификатор, сначала проверить текущее доказательство в рабочих тестах. Ядро ради сценария не переименовывать.

### 3.5. Приёмка #430

- [ ] Diff по `src/**`, `dist/**`, `schemas/**`, `action.yml`, `.github/workflows/**` равен нулю.
- [ ] Выполнить новый тест и полный набор проверок.
- [ ] Черновая проверка успешна → `Ready` на точной голове успешно → слияние точной головы → проверки после слияния успешны.
- [ ] Если появляется необходимость менять ядро, остановить #430 и оформить отдельный архитектурный разрыв.

---

## Задача 4 — C3.5d: `governance-cutover` и сведение корпуса

**GitHub-задача:** #431. Начинать только после принятия #430.

**Дополнительно разрешён:** `README.md`.

### 4.1. Красная проверка финального набора

- [ ] Первый commit меняет только общий тест:

```js
assert.deepEqual(discovered, [
  "contract-evidence",
  "governance-cutover",
  "minimal-diff-policy",
  "surgical-change",
  "version-transition",
]);
```

Ожидаемый RED возникает только из-за отсутствующего `governance-cutover`.

### 4.2. Общий адаптер `check-pr`

- [ ] Ветвление исполнителя допускается только по публичной команде:

```js
if (manifest.command === "check-diff") return runCheckDiffCase(...);
if (manifest.command === "check-pr") return runCheckPrCase(...);
throw new Error(`unsupported command: ${manifest.command}`);
```

Ветвление по идентификатору сценария запрещено.

- [ ] После фиксации `BASE` и `HEAD` создать вне diff `event.json`:

```js
writeFileSync(eventPath, JSON.stringify({
  pull_request: {
    number: 42,
    base: { sha: base, ref: "main" },
    head: { sha: head },
    body: prBody,
  },
  repository: { full_name: "owner/repo" },
}));
```

- [ ] Минимальную подмену `gh` генерировать только как транспорт существующих входов:

```js
if (args.includes("--version")) console.log("gh 0.0");
else if (query === ".body") console.log(issueBody);
else if (query.includes("author_association")) console.log(JSON.stringify({
  user: { login: "maintainer", type: "User" },
  author_association: "OWNER",
  labels: [],
}));
else if (query.includes("permission")) {
  console.log(JSON.stringify({ permission: "write", role_name: "write" }));
} else console.log(JSON.stringify({ labels: [] }));
```

- [ ] Запускать настоящий процесс:

```js
spawnSync(process.execPath, [cli, "--repo-root", temp, "check-pr"], {
  cwd: temp,
  encoding: "utf-8",
  env: {
    ...process.env,
    GITHUB_EVENT_PATH: eventPath,
    PATH: `${fakeGhDir}:${process.env.PATH}`,
  },
});
```

- [ ] Поскольку `check-pr` выдаёт текст, извлекать только публичные строки отказа:

```js
const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const diagnostics = [...output.matchAll(/^FAIL:\s+([^\n]+)/gm)]
  .map((match) => match[1].trim());
```

### 4.3. Сценарий `governance-cutover`

- [ ] Базовая policy содержит `repo-policy.json` в `paths.governance_paths`.
- [ ] Оба варианта предлагают одинаковую более строгую `HEAD` policy: добавить `secrets/**` в `paths.forbidden`.
- [ ] Оба тела PR содержат один `ChangeIntent` и `Fixes #77`:

```repo-guard-yaml
change_type: governance
scope:
  - repo-policy.json
budgets:
  max_new_files: 0
  max_net_added_lines: 50
anchors:
  affects: []
  implements: []
  verifies: []
must_touch:
  - repo-policy.json
must_not_touch: []
expected_effects:
  - Управляющая политика стала строже
```

- [ ] Связанная issue положительного варианта содержит:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
allow_policy_relaxation: []
```

- [ ] Связанная issue отрицательного варианта не содержит блока `repo-guard-grant`.
- [ ] Положительный вариант ожидает `0`; отрицательный — `1` и `governance-change-authorization`.

### 4.4. Финальные инварианты корпуса

- [ ] Для каждого `scenario.json` механически проверить:

```text
title_ru содержит кириллицу
summary_ru содержит кириллицу
каждый case имеет title_ru
есть минимум один положительный case
есть минимум один отрицательный case
нет неизвестных полей
```

- [ ] Явно запретить идентификаторы `workflow-evidence` и `parallel-readiness`.
- [ ] Не фиксировать число внутренних файлов сценария и не создавать ручную матрицу возможностей.

### 4.5. Навигация

- [ ] В корневой `README.md` добавить короткую ссылку на `examples/scenarios/` и объяснить, что это единственный исполняемый каталог примеров и будущий источник C3.6.
- [ ] Не копировать туда policy, `ChangeIntent` или содержимое `scenario.json`.

### 4.6. Финальная приёмка #431

- [ ] Выполнить:

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
node dist/repo-guard.mjs
npm pack --dry-run
```

- [ ] Проверить, что пакет уже включает `examples/scenarios/**` через существующее `files: ["examples/"]`; `package.json` не менять.
- [ ] Проверить нулевой diff запрещённых рабочих поверхностей.
- [ ] Черновая проверка успешна → `Ready` на точной голове успешно с `Run PR policy check` → слияние точной головы → проверки после слияния успешны.

### 4.7. Закрытие #376

- [ ] После post-merge проверить живой `main` и записать в #376:

```text
accepted main SHA
5 scenario ids
PASS/FAIL case counts
all scenarios use production CLI
runtime kinds = 1
FactRef sources = 4
relation descriptors = 10
scenario production concepts = 0
no workflow-evidence
no parallel-readiness
README points to canonical corpus
package contains examples/scenarios/**
post-merge validate GREEN
post-merge smoke-pack GREEN
```

- [ ] Только после этого закрыть #376 как `completed`.
- [ ] Не создавать работу C3.6 внутри C3.5.

## Самопроверка плана

```text
один источник сценариев              -> задачи 1-4
реальные Git BASE/HEAD               -> задача 1
рабочий check-diff                   -> задачи 1-3
рабочий check-pr                     -> задача 4
русские пояснения                    -> задачи 1-4
ровно пять архитектурных сценариев   -> задачи 1-4
нет workflow/parallel resurrection   -> границы + задача 4
будущий Pages читает тот же корпус   -> задача 4
RED-first каждого среза              -> первый шаг каждой задачи
exact-head acceptance                -> финал каждой задачи
```

Плейсхолдеров и отложенных архитектурных решений нет. Общие интерфейсы между срезами заранее фиксированы: `discoverScenarios`, материализация репозитория и `runCheckDiffCase`; в C3.5d добавляется только общий `runCheckPrCase` по публичному полю `command`.
