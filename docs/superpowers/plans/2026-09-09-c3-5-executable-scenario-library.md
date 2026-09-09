# C3.5 — план реализации исполняемой библиотеки сценариев

> **Для агентных исполнителей:** обязательный поднавык — `superpowers:subagent-driven-development` или `superpowers:executing-plans`. Выполнять задачи последовательно по чекбоксам `- [ ]`; следующий срез не начинается до принятия предыдущего в `main`.

**Цель:** создать один маленький корпус `examples/scenarios/**`, который одновременно является исполняемым регрессионным доказательством, человеческим примером и будущим источником данных для C3.6.

**Архитектура:** сценарии являются только данными. Один тестовый исполнитель создаёт реальные временные Git-репозитории с `BASE` и `HEAD` и запускает настоящий `dist/repo-guard.mjs`. Семантика политики остаётся только в production `repo-guard`; тестовая инфраструктура проверяет материализацию, код завершения и ограниченный набор стабильных идентификаторов диагностик.

**Стек:** Node.js 24, встроенные `node:test`, `node:assert`, `node:fs`, `node:path`, `node:os`, `node:child_process`, Git CLI и существующий `dist/repo-guard.mjs`.

**Спека:** `docs/superpowers/specs/2026-09-09-c3-5-executable-scenario-library-design.md`

**Задачи:** #428 → #429 → #430 → #431; родитель #376; дорожная карта #370.

## Глобальные ограничения

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

Если любой срез требует изменения одной из запрещённых production-поверхностей, выполнение этого среза останавливается. Такое требование оформляется как отдельный архитектурный разрыв, а не как разрешение расширить C3.5.

## Карта файлов

Единственный исполнитель корпуса:

```text
tests/test-c3-5-scenario-library.mjs
```

Он отвечает только за:

```text
обнаружение examples/scenarios/*/scenario.json
техническую проверку manifest
копирование base/**
создание Git BASE
наложение cases/<case>/head/**
удаление delete_paths
создание Git HEAD
подготовку вне diff дополнительных входов
запуск production CLI
проверку exit code
проверку обязательных diagnostic ids
```

Каноническое описание формы корпуса:

```text
examples/scenarios/README.md
```

Данные сценариев:

```text
examples/scenarios/minimal-diff-policy/**
examples/scenarios/surgical-change/**
examples/scenarios/version-transition/**
examples/scenarios/contract-evidence/**
examples/scenarios/governance-cutover/**
```

`README.md` корня изменяется только в C3.5d и только для навигации к корпусу.

---

### Задача 1: C3.5a — форма корпуса, универсальный исполнитель и `minimal-diff-policy`

**Issue:** #428

**Файлы:**
- Создать: `tests/test-c3-5-scenario-library.mjs`
- Создать: `examples/scenarios/README.md`
- Создать: `examples/scenarios/minimal-diff-policy/scenario.json`
- Создать: `examples/scenarios/minimal-diff-policy/base/repo-policy.json`
- Создать: `examples/scenarios/minimal-diff-policy/base/src/app.txt`
- Создать: `examples/scenarios/minimal-diff-policy/cases/pass/head/src/app.txt`
- Создать: `examples/scenarios/minimal-diff-policy/cases/fail-forbidden/head/forbidden.txt`

**Интерфейсы:**
- Потребляет: `tests/run.mjs` автоматически обнаруживает `test-*.mjs`; `dist/repo-guard.mjs` принимает `--repo-root`, `check-diff`, `--base`, `--head`, `--change-intent`, `--format json`.
- Производит: общий исполнитель, который последующие задачи расширяют только данными; функция обнаружения не содержит списка имён сценариев.

- [ ] **Шаг 1. Создать только RED-тест**

Первый коммит содержит только `tests/test-c3-5-scenario-library.mjs`.

Минимальный RED обязан проверить отсутствие принятого первого сценария, не реализуя исполнитель заранее:

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

- [ ] **Шаг 2. Зафиксировать RED через Draft PR**

Создать ветку от принятого `main`, commit только теста и Draft PR `Fixes #428`.

Запустить полный CI. Ожидаемый результат нового теста:

```text
FAIL: каталог examples/scenarios ещё не создан
```

При этом до нового теста должны оставаться зелёными `check:dist`, compression metrics, текущая self-policy, doctor и старые тесты. Если падает что-либо ещё, сначала локализовать причину, не добавляя данные сценария.

- [ ] **Шаг 3. Превратить RED-тест в универсальный исполнитель**

Расширить тот же файл следующими общими функциями:

```js
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf-8",
  stdio: "pipe",
}).trim();

function copyTree(source, target) {
  cpSync(source, target, { recursive: true });
}

function discoverScenarios() {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(scenariosRoot, entry.name, "scenario.json")))
    .map((entry) => entry.name)
    .sort();
}
```

Техническая проверка `scenario.json` должна быть локальной и маленькой. Разрешить только:

```text
id
title_ru
summary_ru
command
cases
```

Для каждого case разрешить только:

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

Проверить:

```js
assert.equal(manifest.id, directoryName);
assert.match(manifest.title_ru, /[А-Яа-яЁё]/);
assert.match(manifest.summary_ru, /[А-Яа-яЁё]/);
assert.ok(["check-diff", "check-pr"].includes(manifest.command));
assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);
```

Не создавать JSON Schema для manifest и не добавлять его в product schemas.

- [ ] **Шаг 4. Реализовать материализацию реального Git-перехода**

Для каждого case:

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
for (const path of testCase.delete_paths || []) rmSync(resolve(temp, path), { recursive: true, force: true });
git(temp, "add", "-A");
git(temp, "commit", "-m", "HEAD");
const head = git(temp, "rev-parse", "HEAD");
```

Если `head/` отсутствует, это ошибка целостности case, а не разрешение пустого перехода.

Дополнительный `change_intent` копировать в temp **после** HEAD commit, чтобы вход команды не попадал в проверяемый diff:

```js
if (testCase.change_intent) {
  copyFileSync(resolve(scenarioRoot, testCase.change_intent), resolve(temp, ".scenario-change-intent.json"));
}
```

- [ ] **Шаг 5. Запускать настоящий `check-diff` процесс**

Общий путь для `command === "check-diff"`:

```js
const args = [
  cli,
  "--repo-root", temp,
  "check-diff",
  "--base", base,
  "--head", head,
  "--format", "json",
];
if (testCase.change_intent) args.push("--change-intent", ".scenario-change-intent.json");

const result = spawnSync(process.execPath, args, {
  cwd: temp,
  encoding: "utf-8",
  env: process.env,
});
```

JSON parse выполняется только над публичным `AnalysisReport`:

```js
const report = JSON.parse(result.stdout);
assert.equal(result.status, testCase.expected_exit_code);
assert.equal(report.exitCode, testCase.expected_exit_code);
const actualDiagnostics = report.violations.map((item) => item.rule).sort();
for (const expected of testCase.expected_diagnostics) {
  assert.ok(actualDiagnostics.includes(expected), `${manifest.id}/${testCase.id}: missing ${expected}`);
}
if (testCase.expected_exit_code === 0) assert.deepEqual(report.violations, []);
```

`expected_diagnostics` является обязательным подмножеством для отрицательного case, а не снимком всего отчёта.

- [ ] **Шаг 6. Добавить каноническую документацию формы корпуса**

`examples/scenarios/README.md` кратко фиксирует на русском:

```text
сценарий = base + cases + scenario.json
base/head материализуются как реальные Git commits
manifest не содержит семантику policy
каждый case запускается production CLI
Pages C3.6 читает тот же corpus
```

Не дублировать содержимое конкретных policy-файлов.

- [ ] **Шаг 7. Добавить `minimal-diff-policy`**

`scenario.json`:

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

`base/repo-policy.json`:

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

Файлы:

```text
base/src/app.txt                 -> base
cases/pass/head/src/app.txt      -> changed
cases/fail-forbidden/head/forbidden.txt -> forbidden
```

- [ ] **Шаг 8. Проверить focused GREEN и полный suite**

Запуски:

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
node dist/repo-guard.mjs
```

Ожидание: все GREEN; новый runner сообщает два case первого сценария как принятые.

- [ ] **Шаг 9. Принять #428**

Перевести PR в Ready только после Draft GREEN. На неизменном exact head получить:

```text
validate = GREEN
smoke-pack = GREEN
Run PR policy check = GREEN
```

Merge exact head. Затем дождаться post-merge `validate + smoke-pack = GREEN`. #428 должна закрыться `completed` через `Fixes #428`.

---

### Задача 2: C3.5b — `surgical-change` и `version-transition`

**Issue:** #429

**Файлы:**
- Изменить: `tests/test-c3-5-scenario-library.mjs`
- Создать: `examples/scenarios/surgical-change/**`
- Создать: `examples/scenarios/version-transition/**`

**Интерфейсы:**
- Потребляет: принятый в C3.5a `discoverScenarios()`, материализацию BASE/HEAD и `check-diff` adapter.
- Производит: два новых чистых сценария; общий исполнитель не получает ветвления по `manifest.id`.

- [ ] **Шаг 1. RED: потребовать два новых идентификатора**

Первый commit меняет только тест. После обнаружения корпуса добавить:

```js
for (const required of ["minimal-diff-policy", "surgical-change", "version-transition"]) {
  assert.ok(discovered.includes(required), `C3.5b: отсутствует ${required}`);
}
```

Запустить только новый тест. Ожидание: `minimal-diff-policy` проходит, RED возникает на первом отсутствующем новом сценарии.

- [ ] **Шаг 2. Добавить `surgical-change` без изменения исполнителя**

Manifest:

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

Общий `change-intent.json`:

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

Base policy — минимальная валидная policy без дополнительных ограничений; `base/src/app.txt` существует. PASS меняет только `src/app.txt`. FAIL меняет `src/app.txt` и добавляет `docs/oops.md`, поэтому scope и must-touch остаются допустимыми, а отрицательное доказательство локализуется в `must-not-touch`.

- [ ] **Шаг 3. Добавить `version-transition` без изменения исполнителя**

Manifest:

```json
{
  "id": "version-transition",
  "title_ru": "Переход версии между снимками",
  "summary_ru": "Проверяет рост SemVer между BASE и HEAD обычным document relation.",
  "command": "check-diff",
  "cases": [
    {
      "id": "pass",
      "title_ru": "Версия увеличена",
      "expected_exit_code": 0,
      "expected_diagnostics": []
    },
    {
      "id": "fail-downgrade",
      "title_ru": "Версия уменьшена",
      "expected_exit_code": 1,
      "expected_diagnostics": ["document-relation:release-revision"]
    }
  ]
}
```

В base policy использовать уже принятый generic relation:

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

Файлы:

```text
base/meta/REVISION                         = 1.2.3
cases/pass/head/meta/REVISION              = 1.2.4
cases/fail-downgrade/head/meta/REVISION    = 1.2.2
```

- [ ] **Шаг 4. Запустить focused и полный GREEN**

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
```

Никаких изменений runner, кроме доказанного общего дефекта. Любое желание добавить `if (manifest.id === ...)` является нарушением плана.

- [ ] **Шаг 5. Принять #429**

Draft GREEN → Ready exact-head GREEN → exact-head merge → post-merge `validate + smoke-pack` GREEN. Только затем переходить к #430.

---

### Задача 3: C3.5c — `contract-evidence`

**Issue:** #430

**Файлы:**
- Изменить: `tests/test-c3-5-scenario-library.mjs`
- Создать: `examples/scenarios/contract-evidence/scenario.json`
- Создать: `examples/scenarios/contract-evidence/base/repo-policy.json`
- Создать: `examples/scenarios/contract-evidence/base/contracts/spec.json`
- Создать: `examples/scenarios/contract-evidence/base/contracts/checks.yaml`
- Создать: `examples/scenarios/contract-evidence/base/docs/spec.md`
- Создать: `examples/scenarios/contract-evidence/base/tests/gate.mjs`
- Создать: `examples/scenarios/contract-evidence/cases/pass/head/contracts/spec.json`
- Создать: `examples/scenarios/contract-evidence/cases/pass/head/contracts/checks.yaml`

**Интерфейсы:**
- Потребляет: только принятый `check-diff` runner и существующий `contract_conformance` macro.
- Производит: обычные corpus data; не добавляет знание `anum_docs`.

- [ ] **Шаг 1. RED: потребовать `contract-evidence`**

Первый commit меняет только corpus falsifier:

```js
assert.ok(discovered.includes("contract-evidence"), "C3.5c: отсутствует contract-evidence");
```

Все C3.5a–b сценарии должны пройти до этой проверки.

- [ ] **Шаг 2. Создать policy через уже принятый macro**

Использовать минимальную policy с:

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

`paths.governance_paths` должен включать `repo-policy.json` и `contracts/**`, как требует macro control boundary.

- [ ] **Шаг 3. Создать валидную base topology**

`contracts/spec.json`:

```json
{
  "schema": "spec-v1",
  "status": "accepted",
  "accepted": true,
  "conformanceCorpus": "contracts/checks.yaml",
  "owners": { "spec": "docs/spec.md" }
}
```

`contracts/checks.yaml`:

```yaml
contract: spec-v1
status: accepted
accepted: true
requiredGates:
  - tests/gate.mjs
```

Также создать `docs/spec.md` и `tests/gate.mjs`.

- [ ] **Шаг 4. PASS меняет contract и conformance вместе**

PASS HEAD сохраняет те же связи и меняет нейтральное содержимое обоих документов, например добавляет поле `revision: 2` в contract и `revision: 2` в conformance. Это создаёт реальный diff и соблюдает semantic cochange group.

Manifest PASS ожидает `0` и пустые diagnostics.

- [ ] **Шаг 5. FAIL удаляет требуемое evidence без нового semantic switch**

В manifest отрицательного case использовать:

```json
{
  "id": "fail-missing-gate",
  "title_ru": "Обязательное исполняемое свидетельство отсутствует",
  "expected_exit_code": 1,
  "expected_diagnostics": ["document-relation:contract-conformance:required-path:1"],
  "delete_paths": ["tests/gate.mjs"]
}
```

Для этого case `head/` всё равно должен существовать; положить в него изменённый `contracts/spec.json` и `contracts/checks.yaml`, чтобы HEAD commit одновременно содержит contract/conformance переход и удаление gate.

Если реальный diagnostic id отличается от уже принятого `document-relation:contract-conformance:required-path:1`, сначала проверить текущее production evidence. Не переименовывать engine ради сценария.

- [ ] **Шаг 6. Проверить отсутствие engine gap**

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
```

`src/**`, `dist/**`, schemas, Action и workflows должны иметь нулевой diff. Если нет — остановить #430 как обнаруженный архитектурный разрыв.

- [ ] **Шаг 7. Принять #430**

Draft GREEN → Ready exact-head GREEN → exact-head merge → post-merge GREEN. Только затем #431.

---

### Задача 4: C3.5d — `governance-cutover`, навигация и финальный аудит

**Issue:** #431

**Файлы:**
- Изменить: `tests/test-c3-5-scenario-library.mjs`
- Создать: `examples/scenarios/governance-cutover/**`
- Изменить: `README.md`

**Интерфейсы:**
- Потребляет: тот же corpus manifest и materializer.
- Расширяет только транспортный adapter исполнителя для `command === "check-pr"`.
- Производит: окончательный корпус из ровно пяти архитектурных сценариев и ссылку из корневого README.

- [ ] **Шаг 1. RED: потребовать пятый сценарий и точный финальный набор**

Первый commit меняет только тест:

```js
assert.deepEqual(discovered, [
  "contract-evidence",
  "governance-cutover",
  "minimal-diff-policy",
  "surgical-change",
  "version-transition",
]);
```

Ожидание: четыре принятых сценария проходят, RED только из-за отсутствия `governance-cutover`.

- [ ] **Шаг 2. Добавить общий `check-pr` transport adapter**

Не создавать ветвление по имени сценария. Ветвление допустимо только по публичной команде manifest:

```js
if (manifest.command === "check-diff") return runCheckDiffCase(...);
if (manifest.command === "check-pr") return runCheckPrCase(...);
throw new Error(`unsupported command: ${manifest.command}`);
```

`runCheckPrCase` после BASE/HEAD commits создаёт вне diff `event.json`:

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

Минимальный fake `gh` генерируется исполнителем из `issue_body` case и отвечает только на уже существующие production-запросы:

```js
if (args.includes("--version")) console.log("gh 0.0");
else if (query === ".body") console.log(issueBody);
else if (query.includes("author_association")) console.log(JSON.stringify({
  user: { login: "maintainer", type: "User" },
  author_association: "OWNER",
  labels: [],
}));
else if (query.includes("permission")) console.log(JSON.stringify({ permission: "write", role_name: "write" }));
else console.log(JSON.stringify({ labels: [] }));
```

Запуск:

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

Так как `check-pr` сейчас выдаёт text, стабильные диагностические идентификаторы извлекаются только из строк публичного renderer:

```js
const output = `${result.stdout || ""}\n${result.stderr || ""}`;
const diagnostics = [...output.matchAll(/^FAIL:\s+([^\n]+)/gm)]
  .map((match) => match[1].trim());
```

Не импортировать `runCheckPR` напрямую: нужен именно процессный boundary.

- [ ] **Шаг 3. Создать `governance-cutover`**

Base policy содержит `repo-policy.json` в `paths.governance_paths` и обычные минимальные diff/content/cochange поля.

Оба case предлагают одинаковую HEAD policy: добавить в `paths.forbidden` новый шаблон `secrets/**`. Это tightening, поэтому сценарий проверяет доверенную governance authorization без отдельного policy relaxation grant.

Оба `pr-body.md` содержат один и тот же `ChangeIntent` и `Fixes #77`:

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

PASS issue body содержит:

```repo-guard-grant
authorized_governance_paths:
  - repo-policy.json
allow_policy_relaxation: []
```

FAIL issue body не содержит `repo-guard-grant`.

Manifest:

```json
{
  "id": "governance-cutover",
  "title_ru": "Доверенное изменение управляющей политики",
  "summary_ru": "Показывает, что изменение governance-пути требует отдельного разрешения из связанной issue.",
  "command": "check-pr",
  "cases": [
    {
      "id": "pass",
      "title_ru": "Доверенное разрешение присутствует",
      "expected_exit_code": 0,
      "expected_diagnostics": [],
      "pr_body": "cases/pass/pr-body.md",
      "issue_body": "cases/pass/issue-body.md"
    },
    {
      "id": "fail-no-grant",
      "title_ru": "Разрешение отсутствует",
      "expected_exit_code": 1,
      "expected_diagnostics": ["governance-change-authorization"],
      "pr_body": "cases/fail-no-grant/pr-body.md",
      "issue_body": "cases/fail-no-grant/issue-body.md"
    }
  ]
}
```

- [ ] **Шаг 4. Добавить финальные corpus invariants**

Тест должен механически проверить для каждого manifest:

```text
title_ru содержит кириллицу
summary_ru содержит кириллицу
каждый case имеет title_ru
каждый scenario имеет минимум один expected_exit_code = 0
каждый scenario имеет минимум один expected_exit_code != 0
нет scenario ids workflow-evidence и parallel-readiness
нет неизвестных manifest/case полей
```

Не фиксировать число файлов внутри сценария и не создавать ручную матрицу capability → scenario.

- [ ] **Шаг 5. Синхронизировать корневой README**

Добавить короткий раздел или абзац со ссылкой:

```text
examples/scenarios/
```

Объяснить, что этот каталог является единственным исполняемым каталогом примеров и будущим источником C3.6. Не копировать policy JSON, ChangeIntent или scenario manifests в README.

- [ ] **Шаг 6. Финальный focused и full GREEN**

```bash
node tests/test-c3-5-scenario-library.mjs
npm test
npm run check:dist
npm run compression:metrics
node dist/repo-guard.mjs
npm pack --dry-run
```

Проверить, что `examples/scenarios/**` попадает в package через уже существующее `files: ["examples/"]`; `package.json` не менять.

Diff по запрещённым production-поверхностям должен быть пуст.

- [ ] **Шаг 7. Принять #431**

Draft GREEN → Ready exact-head:

```text
validate = GREEN
smoke-pack = GREEN
Run PR policy check = GREEN
```

Merge exact head. Дождаться post-merge `validate + smoke-pack = GREEN`.

- [ ] **Шаг 8. Финальный аудит #376**

После post-merge проверить live `main` и записать в #376:

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

Только после этого закрыть #376 с `state_reason = completed`.

Не создавать C3.6 ветку, issue-дочернюю работу или Pages-файлы внутри C3.5.

## Самопроверка плана

Покрытие спеки:

```text
один corpus source                  -> задачи 1-4
реальные Git BASE/HEAD              -> задача 1
production check-diff               -> задачи 1-3
production check-pr                 -> задача 4
русские human metadata              -> задачи 1-4
5 архитектурных сценариев           -> задачи 1-4
без workflow/parallel revival       -> глобальные границы + задача 4
будущий Pages читает тот же corpus  -> README корпуса + задача 4
RED-first каждого среза             -> первый шаг каждой задачи
exact-head acceptance               -> финальный шаг каждой задачи
```

Плейсхолдеров, отложенных архитектурных решений и специальных ветвей по scenario id в плане нет. Имена интерфейсов между задачами неизменны: `discoverScenarios`, общий materializer, `runCheckDiffCase`, а в C3.5d добавляется только общий `runCheckPrCase` по значению публичного поля `command`.
