import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const oldModule = ["policy", "profiles"].join("-");
const newModule = ["policy", "packs"].join("-");
const oldIdentifiers = [
  ["Profile", "Source"].join(""),
  ["Profile", "Rule"].join(""),
  ["Profile", "Spec"].join(""),
  ["Profile", "Config"].join(""),
  ["Profile", "ValidationError"].join(""),
  ["compile", "ProfilePolicy"].join(""),
  ["expand", "PolicyProfile"].join(""),
  ["resolve", "PolicyProfile"].join(""),
  ["profile", " compilation"].join(""),
  ["policy", "Profiles"].join(""),
  ["policy", "_profiles_"].join(""),
];

const walk = (root) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path.replaceAll("\\", "/")];
  });
};

const stale = [];
const expectPath = (path, exists) => {
  if (existsSync(path) !== exists) stale.push(`${exists ? "missing" : "stale"} path: ${path}`);
};

for (const root of ["src", "dist", "scripts", "tests"]) {
  for (const path of walk(root)) {
    if (!/\.(?:mts|mjs)$/.test(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.includes(oldModule)) stale.push(`${path}: ${oldModule}`);
    for (const token of oldIdentifiers) {
      if (text.includes(token)) stale.push(`${path}: ${token}`);
    }
  }
}

expectPath(`src/${oldModule}.mts`, false);
expectPath(`dist/${oldModule}.mjs`, false);
expectPath(`tests/test-${oldModule}.mjs`, false);
expectPath(`docs/requirements-strict-${["profile"].join("")}.md`, false);
expectPath(`src/${newModule}.mts`, true);
expectPath(`dist/${newModule}.mjs`, true);
expectPath(`tests/test-${newModule}.mjs`, true);
expectPath("docs/requirements-strict-pack.md", true);

const currentGuide = existsSync("docs/requirements-strict-pack.md")
  ? "docs/requirements-strict-pack.md"
  : `docs/requirements-strict-${["profile"].join("")}.md`;
if (existsSync(currentGuide)) {
  const guide = readFileSync(currentGuide, "utf8");
  const legacyPublicTokens = [
    ["profile", "_overrides"].join(""),
    `"${["profile"].join("")}"`,
  ];
  for (const token of legacyPublicTokens) {
    if (guide.includes(token)) stale.push(`${currentGuide}: ${token}`);
  }
  if (/профил/iu.test(guide)) stale.push(`${currentGuide}: русское profile-вocabulary`);
}

assert.deepEqual(stale, [], `stale pack/profile vocabulary:\n${stale.join("\n")}`);
console.log("pack vocabulary convergence passed");
