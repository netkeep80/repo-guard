import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenariosRoot = resolve(root, "examples/scenarios");
const cli = resolve(root, "dist/repo-guard.mjs");
const topLevelFields = new Set(["id", "title_ru", "summary_ru", "command", "cases"]);
const caseFields = new Set([
  "id",
  "title_ru",
  "expected_exit_code",
  "expected_diagnostics",
  "delete_paths",
  "change_intent",
  "pr_body",
  "issue_body",
]);
const allowedCommands = new Set(["check-diff", "check-pr"]);
const russianText = /[А-Яа-яЁё]/u;

const git = (cwd, ...args) => execFileSync("git", args, {
  cwd,
  encoding: "utf-8",
  stdio: "pipe",
}).trim();

function discoverScenarios() {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(resolve(scenariosRoot, entry.name, "scenario.json")))
    .map((entry) => entry.name)
    .sort();
}

function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(resolve(source, entry.name), resolve(target, entry.name), { recursive: true });
  }
}

function validateManifest(scenarioId, manifest) {
  assert.deepEqual(
    Object.keys(manifest).sort(),
    [...topLevelFields].sort(),
    `${scenarioId}: scenario.json содержит неизвестные поля верхнего уровня`,
  );
  assert.equal(manifest.id, scenarioId, `${scenarioId}: id должен совпадать с именем каталога`);
  assert.match(manifest.title_ru, russianText, `${scenarioId}: title_ru должен содержать русский текст`);
  assert.match(manifest.summary_ru, russianText, `${scenarioId}: summary_ru должен содержать русский текст`);
  assert.ok(allowedCommands.has(manifest.command), `${scenarioId}: неизвестная команда ${manifest.command}`);
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0, `${scenarioId}: нужен хотя бы один вариант`);

  for (const testCase of manifest.cases) {
    for (const field of Object.keys(testCase)) {
      assert.ok(caseFields.has(field), `${scenarioId}/${testCase.id}: неизвестное поле ${field}`);
    }
    assert.equal(typeof testCase.id, "string", `${scenarioId}: вариант должен иметь id`);
    assert.match(testCase.title_ru, russianText, `${scenarioId}/${testCase.id}: title_ru должен содержать русский текст`);
    assert.ok([0, 1].includes(testCase.expected_exit_code), `${scenarioId}/${testCase.id}: код завершения должен быть 0 или 1`);
    assert.ok(Array.isArray(testCase.expected_diagnostics), `${scenarioId}/${testCase.id}: expected_diagnostics должен быть массивом`);
    if (manifest.command === "check-pr") {
      assert.equal(typeof testCase.pr_body, "string", `${scenarioId}/${testCase.id}: pr_body обязателен для check-pr`);
      assert.equal(typeof testCase.issue_body, "string", `${scenarioId}/${testCase.id}: issue_body обязателен для check-pr`);
    }
  }
}

function materializeCase(scenarioRoot, testCase) {
  const temp = mkdtempSync(join(tmpdir(), "repo-guard-scenario-"));
  copyTree(resolve(scenarioRoot, "base"), temp);
  git(temp, "init", "-b", "main");
  git(temp, "config", "user.email", "scenario@test.invalid");
  git(temp, "config", "user.name", "repo-guard scenario");
  git(temp, "add", "-A");
  git(temp, "commit", "-m", "BASE");
  const base = git(temp, "rev-parse", "HEAD");

  const caseRoot = resolve(scenarioRoot, "cases", testCase.id);
  const headRoot = resolve(caseRoot, "head");
  assert.ok(existsSync(headRoot), `${testCase.id}: каталог head обязателен`);
  copyTree(headRoot, temp);
  for (const path of testCase.delete_paths || []) {
    rmSync(resolve(temp, path), { recursive: true, force: true });
  }
  git(temp, "add", "-A");
  git(temp, "commit", "-m", "HEAD");
  const head = git(temp, "rev-parse", "HEAD");

  if (testCase.change_intent) {
    cpSync(
      resolve(scenarioRoot, testCase.change_intent),
      resolve(temp, ".scenario-change-intent.json"),
    );
  }
  return { temp, base, head };
}

function runCheckDiff(scenarioId, scenarioRoot, testCase) {
  const { temp, base, head } = materializeCase(scenarioRoot, testCase);
  try {
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
    assert.ifError(result.error);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, testCase.expected_exit_code, `${scenarioId}/${testCase.id}: неверный код процесса\n${result.stderr}`);
    assert.equal(report.exitCode, testCase.expected_exit_code, `${scenarioId}/${testCase.id}: неверный exitCode отчёта`);
    const actual = report.violations.map((item) => item.rule).sort();
    for (const expected of testCase.expected_diagnostics) {
      assert.ok(actual.includes(expected), `${scenarioId}/${testCase.id}: отсутствует диагностика ${expected}; получено ${actual.join(", ")}`);
    }
    if (testCase.expected_exit_code === 0) {
      assert.deepEqual(report.violations, [], `${scenarioId}/${testCase.id}: успешный вариант не должен иметь нарушений`);
    }
    console.log(`PASS: ${scenarioId}/${testCase.id}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function scenarioText(scenarioId, scenarioRoot, testCase, field) {
  const relativePath = testCase[field];
  assert.equal(typeof relativePath, "string", `${scenarioId}/${testCase.id}: ${field} должен указывать на файл`);
  return readFileSync(resolve(scenarioRoot, relativePath), "utf-8");
}

function runCheckPr(scenarioId, scenarioRoot, testCase) {
  const { temp, base, head } = materializeCase(scenarioRoot, testCase);
  const support = mkdtempSync(join(tmpdir(), "repo-guard-scenario-pr-"));
  try {
    const prBody = scenarioText(scenarioId, scenarioRoot, testCase, "pr_body");
    const issueBody = scenarioText(scenarioId, scenarioRoot, testCase, "issue_body");
    const eventPath = resolve(support, "event.json");
    const gh = resolve(support, "gh");

    git(temp, "update-ref", "refs/remotes/origin/main", base);
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        number: 42,
        base: { sha: base, ref: "main" },
        head: { sha: head },
        body: prBody,
      },
      repository: { full_name: "owner/repo" },
    }));
    writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const index = args.indexOf("--jq");
const query = index >= 0 ? args[index + 1] : "";
if (args.includes("--version")) console.log("gh 0.0");
else if (query === ".body") console.log(${JSON.stringify(issueBody)});
else if (query.includes("author_association")) console.log(JSON.stringify({
  body: ${JSON.stringify(issueBody)},
  user: { login: "maintainer", type: "User" },
  author_association: "OWNER",
  labels: [],
}));
else if (query.includes("permission")) console.log(JSON.stringify({ permission: "write", role_name: "write" }));
else console.log(JSON.stringify({ labels: [] }));
`);
    chmodSync(gh, 0o755);

    const result = spawnSync(process.execPath, [cli, "--repo-root", temp, "check-pr"], {
      cwd: temp,
      encoding: "utf-8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        PATH: `${support}:${process.env.PATH}`,
      },
    });
    assert.ifError(result.error);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, testCase.expected_exit_code, `${scenarioId}/${testCase.id}: неверный код процесса\n${output}`);
    const actual = [...output.matchAll(/^\s*FAIL:\s+([^\n]+)/gm)]
      .map((match) => match[1].trim())
      .sort();
    for (const expected of testCase.expected_diagnostics) {
      assert.ok(actual.includes(expected), `${scenarioId}/${testCase.id}: отсутствует диагностика ${expected}; получено ${actual.join(", ")}`);
    }
    if (testCase.expected_exit_code === 0) {
      assert.deepEqual(actual, [], `${scenarioId}/${testCase.id}: успешный вариант не должен иметь нарушений`);
    }
    console.log(`PASS: ${scenarioId}/${testCase.id}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(support, { recursive: true, force: true });
  }
}

assert.ok(existsSync(scenariosRoot), "C3.5a: каталог examples/scenarios ещё не создан");
const scenarioIds = discoverScenarios();
assert.ok(scenarioIds.includes("minimal-diff-policy"), "C3.5a: отсутствует minimal-diff-policy");

for (const scenarioId of scenarioIds) {
  const scenarioRoot = resolve(scenariosRoot, scenarioId);
  const manifest = JSON.parse(readFileSync(resolve(scenarioRoot, "scenario.json"), "utf-8"));
  validateManifest(scenarioId, manifest);
  for (const testCase of manifest.cases) {
    if (manifest.command === "check-diff") runCheckDiff(scenarioId, scenarioRoot, testCase);
    else if (manifest.command === "check-pr") runCheckPr(scenarioId, scenarioRoot, testCase);
    else assert.fail(`${scenarioId}: неподдерживаемая команда ${manifest.command}`);
  }
}

for (const required of ["surgical-change", "version-transition"]) {
  assert.ok(scenarioIds.includes(required), `C3.5b: отсутствует ${required}`);
}

assert.ok(
  scenarioIds.includes("contract-evidence"),
  "C3.5c: отсутствует contract-evidence",
);

assert.deepEqual(scenarioIds, [
  "contract-evidence",
  "governance-cutover",
  "minimal-diff-policy",
  "surgical-change",
  "version-transition",
], "C3.5d: финальный корпус должен содержать ровно пять принятых сценариев");

console.log(`C3.5 scenario library passed: ${scenarioIds.length} scenario(s)`);
