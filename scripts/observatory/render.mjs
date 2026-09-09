import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid snapshot section: ${name}`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid snapshot string: ${name}`);
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`invalid snapshot array: ${name}`);
  }
}

export function validateObservatorySnapshot(snapshot) {
  requireObject(snapshot, "root");
  if (snapshot.schema_version !== 1) {
    throw new Error("unsupported observatory snapshot schema");
  }

  requireObject(snapshot.accepted, "accepted");
  if (!/^[0-9a-f]{40}$/.test(snapshot.accepted.sha ?? "")) {
    throw new Error("invalid accepted SHA");
  }
  requireObject(snapshot.accepted.ci, "accepted.ci");
  if (snapshot.accepted.ci.conclusion !== "success") {
    throw new Error("snapshot is not backed by successful CI");
  }
  requireString(snapshot.accepted.ci.workflow, "accepted.ci.workflow");
  requireString(snapshot.accepted.ci.run_url, "accepted.ci.run_url");

  requireObject(snapshot.repository, "repository");
  requireString(snapshot.repository.full_name, "repository.full_name");
  if (!/^[^/\s]+\/[^/\s]+$/.test(snapshot.repository.full_name)) {
    throw new Error("invalid repository full name");
  }

  requireObject(snapshot.version, "version");
  requireString(snapshot.version.package_version, "version.package_version");
  requireString(snapshot.version.matching_release_tag, "version.matching_release_tag");
  requireString(snapshot.version.release_truth_status, "version.release_truth_status");

  requireObject(snapshot.policy, "policy");
  requireObject(snapshot.policy.accepted, "policy.accepted");
  requireArray(snapshot.policy.constraint_program, "policy.constraint_program");
  requireString(snapshot.policy.source, "policy.source");

  requireObject(snapshot.architecture, "architecture");
  requireObject(snapshot.architecture.current, "architecture.current");
  requireObject(
    snapshot.architecture.current.architecture,
    "architecture.current.architecture",
  );
  requireObject(snapshot.architecture.provenance, "architecture.provenance");
  requireString(snapshot.architecture.provenance.source, "architecture.provenance.source");

  requireObject(snapshot.ci, "ci");
  requireString(snapshot.ci.source, "ci.source");
  requireArray(snapshot.ci.triggers, "ci.triggers");
  requireArray(snapshot.ci.jobs, "ci.jobs");

  requireArray(snapshot.scenarios, "scenarios");
  for (const scenario of snapshot.scenarios) {
    requireObject(scenario, "scenario");
    for (const field of ["id", "title_ru", "summary_ru", "command"]) {
      requireString(scenario[field], `scenario.${field}`);
    }
    requireArray(scenario.cases, `scenario.${scenario.id}.cases`);
    requireObject(scenario.provenance, `scenario.${scenario.id}.provenance`);
    requireString(
      scenario.provenance.source,
      `scenario.${scenario.id}.provenance.source`,
    );
    for (const item of scenario.cases) {
      requireObject(item, `scenario.${scenario.id}.case`);
      requireString(item.id, `scenario.${scenario.id}.case.id`);
      requireString(item.title_ru, `scenario.${scenario.id}.case.title_ru`);
      if (!Number.isInteger(item.expected_exit_code)) {
        throw new Error(`invalid expected exit code: ${scenario.id}/${item.id}`);
      }
      requireArray(
        item.expected_diagnostics,
        `scenario.${scenario.id}.case.expected_diagnostics`,
      );
    }
  }

  requireArray(snapshot.sources, "sources");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonBlock(value) {
  return `<pre><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`;
}

function list(values, className = "chips") {
  if (!values.length) return '<p class="muted">Нет данных в снимке.</p>';
  return `<ul class="${className}">${values
    .map((value) => `<li><code>${escapeHtml(value)}</code></li>`)
    .join("")}</ul>`;
}

function immutableSourceUrl(snapshot, path) {
  const base = `https://github.com/${snapshot.repository.full_name}`;
  const sha = snapshot.accepted.sha;
  if (path.endsWith("/**")) {
    return `${base}/tree/${sha}/${path.slice(0, -3)}`;
  }
  return `${base}/blob/${sha}/${path}`;
}

function immutableCommitUrl(snapshot) {
  return `https://github.com/${snapshot.repository.full_name}/commit/${snapshot.accepted.sha}`;
}

function sourceLink(snapshot, path, label = path) {
  return `<a href="${escapeHtml(immutableSourceUrl(snapshot, path))}"><code>${escapeHtml(label)}</code></a>`;
}

function renderScenarioCard(snapshot, scenario) {
  const cases = scenario.cases.map((item) => {
    const result = item.expected_exit_code === 0 ? "PASS" : "FAIL";
    const diagnostics = item.expected_diagnostics.length
      ? item.expected_diagnostics.map((value) => `<code>${escapeHtml(value)}</code>`).join(", ")
      : "нет";
    return `
      <li class="case ${result.toLowerCase()}" data-case-result="${result}">
        <div class="case-head">
          <strong>${escapeHtml(item.title_ru)}</strong>
          <span class="badge ${result.toLowerCase()}">${result}</span>
        </div>
        <div>Ожидаемый код выхода: <code>${escapeHtml(item.expected_exit_code)}</code></div>
        <div>Ожидаемая диагностика: ${diagnostics}</div>
      </li>`;
  }).join("");

  return `
    <article class="card scenario" data-scenario-id="${escapeHtml(scenario.id)}">
      <div class="eyebrow"><code>${escapeHtml(scenario.command)}</code></div>
      <h3>${escapeHtml(scenario.title_ru)}</h3>
      <p>${escapeHtml(scenario.summary_ru)}</p>
      <ul class="cases">${cases}
      </ul>
      <p class="source">Источник: ${sourceLink(
        snapshot,
        scenario.provenance.source,
      )}</p>
    </article>`;
}

function renderCiJobs(snapshot) {
  return snapshot.ci.jobs.map((job) => `
    <article class="card">
      <h3><code>${escapeHtml(job.id)}</code></h3>
      ${list(Array.isArray(job.steps) ? job.steps : [], "plain")}
    </article>`).join("");
}

function canonicalSources(snapshot) {
  const paths = new Set(snapshot.sources);
  paths.add(snapshot.policy.source);
  paths.add(snapshot.ci.source);
  paths.add(snapshot.architecture.provenance.source);
  for (const scenario of snapshot.scenarios) {
    paths.add(scenario.provenance.source);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function renderObservatory(snapshot) {
  validateObservatorySnapshot(snapshot);

  const architecture = snapshot.architecture.current.architecture;
  const factSources = Array.isArray(architecture.canonical_fact_sources)
    ? architecture.canonical_fact_sources
    : [];
  const runtimeKinds = Array.isArray(architecture.runtime_constraint_kind_names)
    ? architecture.runtime_constraint_kind_names
    : [];
  const relations = Array.isArray(architecture.primitive_descriptor_kinds)
    ? architecture.primitive_descriptor_kinds
    : [];

  const scenarioCards = snapshot.scenarios
    .map((scenario) => renderScenarioCard(snapshot, scenario))
    .join("");
  const sourceItems = canonicalSources(snapshot)
    .map((path) => `<li>${sourceLink(snapshot, path)}</li>`)
    .join("");

  const releaseTruth = snapshot.version.matching_published_release
    ? `<a href="${escapeHtml(snapshot.version.release_url)}">опубликован</a>`
    : "не опубликован для совпадающего тега";

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Обсерватория политики repo-guard</title>
  <meta name="description" content="Детерминированная проекция принятой политики repo-guard только для чтения.">
  <link rel="stylesheet" href="assets/observatory.css">
</head>
<body>
  <header class="hero">
    <div class="eyebrow">repo-guard · только чтение</div>
    <h1>Обсерватория политики</h1>
    <p>Детерминированная статическая проекция принятого состояния. Эта страница ничего не вычисляет заново и не является источником семантической истины.</p>
  </header>

  <main>
    <section id="accepted">
      <h2>Принятое состояние</h2>
      <div class="cards summary">
        <article class="card">
          <h3>Точный коммит</h3>
          <p><a href="${escapeHtml(immutableCommitUrl(snapshot))}"><code>${escapeHtml(snapshot.accepted.sha)}</code></a></p>
        </article>
        <article class="card">
          <h3>Подтверждение CI</h3>
          <p><a href="${escapeHtml(snapshot.accepted.ci.run_url)}">${escapeHtml(snapshot.accepted.ci.workflow)} #${escapeHtml(snapshot.accepted.ci.run_id)}</a></p>
          <p><span class="badge pass">${escapeHtml(snapshot.accepted.ci.conclusion)}</span></p>
        </article>
        <article class="card">
          <h3>Версия и выпуск</h3>
          <p>Пакет: <code>${escapeHtml(snapshot.version.package_version)}</code></p>
          <p>Совпадающий тег: <code>${escapeHtml(snapshot.version.matching_release_tag)}</code></p>
          <p>Выпуск: ${releaseTruth}</p>
          <p>Статус истины: <code>${escapeHtml(snapshot.version.release_truth_status)}</code></p>
        </article>
      </div>
    </section>

    <section id="policy">
      <h2>Собственная политика</h2>
      <p>Показывается принятый машинный документ без повторного разбора его семантики. Источник: ${sourceLink(snapshot, snapshot.policy.source)}.</p>
      ${jsonBlock(snapshot.policy.accepted)}
    </section>

    <section id="architecture">
      <h2>Каноническая архитектура</h2>
      <div class="cards">
        <article class="card">
          <h3>Источники фактов</h3>
          ${list(factSources)}
        </article>
        <article class="card">
          <h3>Исполняемые виды ограничений</h3>
          ${list(runtimeKinds)}
        </article>
        <article class="card">
          <h3>Дескрипторы отношений</h3>
          ${list(relations)}
        </article>
      </div>
      <p class="source">Метрики получены из ${sourceLink(snapshot, snapshot.architecture.provenance.source)}.</p>
    </section>

    <section id="lowering">
      <h2>Понижение ограничений</h2>
      <p>Ниже показан уже скомпилированный программой repo-guard результат. Обсерватория его не пересчитывает и не интерпретирует.</p>
      ${jsonBlock(snapshot.policy.constraint_program)}
    </section>

    <section id="governance">
      <h2>Намерение, управление и доказательства</h2>
      <p>Пояснительная схема отделяет семантику ограничений от транзакционной границы доверия.</p>
      <pre class="topology"><code>ChangeIntent
  ↓
доверенная связанная задача
  ↓
GovernanceGrant
  ↓
сравнение доверенной BASE и предлагаемой HEAD политики
  ↓
AnalysisReport</code></pre>
    </section>

    <section id="ci">
      <h2>Основной процесс проверки</h2>
      <p>Объявленная схема процесса взята из ${sourceLink(snapshot, snapshot.ci.source)}. Успешный запуск принятого коммита показан отдельно выше как evidence.</p>
      <p>Триггеры:</p>
      ${list(snapshot.ci.triggers)}
      <div class="cards">${renderCiJobs(snapshot)}</div>
    </section>

    <section id="compression">
      <h2>Сжатие архитектуры</h2>
      <p>Baseline, текущее состояние и дельта проецируются непосредственно из существующего машинного отчёта.</p>
      ${jsonBlock({
        baseline: snapshot.architecture.baseline,
        current: snapshot.architecture.current,
        delta: snapshot.architecture.delta,
      })}
    </section>

    <section id="scenarios">
      <h2>Исполняемые сценарии</h2>
      <p>Карточки ниже строятся из найденных executable-манифестов; отдельного списка сценариев у страницы нет.</p>
      <div class="cards scenarios">${scenarioCards}</div>
    </section>

    <section id="sources">
      <h2>Канонические источники</h2>
      <p>Ссылки закреплены на точном принятом SHA и не ведут на плавающую ветку.</p>
      <ul class="sources">${sourceItems}</ul>
    </section>
  </main>

  <footer>
    <p>Статическая проекция только для чтения · <code>${escapeHtml(snapshot.repository.full_name)}</code></p>
  </footer>
</body>
</html>
`;
}

export function renderCss() {
  return `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
* { box-sizing: border-box; }
body {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px;
}
a { color: inherit; text-underline-offset: 0.2em; }
code, pre { font-family: ui-monospace, monospace; }
pre {
  overflow-x: auto;
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 10px;
}
header, footer { padding-block: 24px; }
.hero { border-bottom: 1px solid currentColor; }
.hero h1 { margin-block: 6px 10px; font-size: clamp(2rem, 6vw, 4rem); }
section { margin-block: 32px; }
h2 { margin-bottom: 16px; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.card {
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 12px;
}
.card h3 { margin-top: 0; }
.chips, .plain, .cases, .sources { padding-left: 1.25rem; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding-left: 0; }
.chips li, .badge {
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 3px 8px;
}
.cases { display: grid; gap: 10px; list-style: none; padding-left: 0; }
.case { padding: 10px; border-left: 4px solid currentColor; }
.case-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.badge { display: inline-block; font-size: 0.8rem; font-weight: 700; }
.eyebrow, .source, .muted, footer { opacity: 0.72; }
.topology { white-space: pre; }
@media (max-width: 640px) {
  body { padding: 16px; }
  .case-head { align-items: flex-start; flex-direction: column; }
}
`;
}

function parseArgs(argv) {
  const allowed = new Set(["--snapshot", "--output"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || value === undefined) {
      throw new Error(`Unknown or incomplete renderer argument: ${key ?? "<missing>"}`);
    }
    values[key] = value;
  }
  for (const key of allowed) {
    if (!(key in values)) throw new Error(`Missing renderer argument: ${key}`);
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotPath = resolve(args["--snapshot"]);
  const outputRoot = resolve(args["--output"]);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  validateObservatorySnapshot(snapshot);

  const indexPath = resolve(outputRoot, "index.html");
  const cssPath = resolve(outputRoot, "assets", "observatory.css");
  mkdirSync(dirname(indexPath), { recursive: true });
  mkdirSync(dirname(cssPath), { recursive: true });
  writeFileSync(indexPath, renderObservatory(snapshot), "utf8");
  writeFileSync(cssPath, renderCss(), "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
