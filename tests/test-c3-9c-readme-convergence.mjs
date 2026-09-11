import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readme = readFileSync(resolve("README.md"), "utf8");

const requiredMarkers = [
  "FactRef",
  "Constraint Program",
  "primitive_relation",
  "ChangeIntent",
  "GovernanceGrant",
  "examples/scenarios/",
  "Обсерватории политики",
  "RELEASING.md",
  "полный 40-символьный SHA коммита",
  "`init` не подставляет `main` или `latest`",
];

const retiredSections = [
  "### Совместные изменения",
  "## Контроль сжатия",
  "## Пакет политики `requirements-strict`",
  "## Самоприменение в CI",
  "## Структурированный результат",
  "## Самопроверка и заморозка ядра",
];

test("README stays a compact product entry point", () => {
  assert.ok(
    Buffer.byteLength(readme, "utf8") <= 12 * 1024,
    `README.md must stay at or below 12 KiB, got ${Buffer.byteLength(readme, "utf8")} bytes`,
  );
});

test("README contains only current product/release truth", () => {
  assert.doesNotMatch(readme, /будущ(?:ая|ей|ую) C3\.6/i);
  assert.doesNotMatch(readme, /полная история репозитория/i);
  for (const heading of retiredSections) {
    assert.equal(readme.includes(heading), false, `retired README section must stay absent: ${heading}`);
  }

  assert.match(readme, /3\.0\.0[^\n]{0,120}(?:не опублик|unreleased)|(?:не опублик|unreleased)[^\n]{0,120}3\.0\.0/i);
  assert.doesNotMatch(readme, /^\s*npm install -g repo-guard\s*$/m);
  assert.doesNotMatch(readme, /^\s*npx repo-guard\s*$/m);
  assert.match(readme, /uses:\s*netkeep80\/repo-guard@<40-char-SHA>/);
  assert.match(readme, /git checkout "\$REPO_GUARD_SHA"/);
});

test("README retains the current public entry points and trust model", () => {
  for (const marker of requiredMarkers) {
    assert.equal(readme.includes(marker), true, `README must retain ${marker}`);
  }
  assert.match(readme, /trusted BASE|доверенн(?:ая|ой|ую) баз(?:а|ы|у)|базов(?:ой|ая) ветк/i);
});

console.log("C3.9c README convergence contract passed");
