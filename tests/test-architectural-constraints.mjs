import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const manifestPath = resolve(root, "tests/architectural-constraints.json");

assert.equal(
  existsSync(manifestPath),
  true,
  "tests/architectural-constraints.json must define current structural ratchets",
);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const requiredPaths = manifest.required_paths ?? [];
const forbiddenPaths = manifest.forbidden_paths ?? [];
const requiredText = manifest.required_text ?? [];
const forbiddenText = manifest.forbidden_text ?? [];

assert.ok(Array.isArray(requiredPaths), "required_paths must be an array");
assert.ok(Array.isArray(forbiddenPaths), "forbidden_paths must be an array");
assert.ok(Array.isArray(requiredText), "required_text must be an array");
assert.ok(Array.isArray(forbiddenText), "forbidden_text must be an array");

for (const path of requiredPaths) {
  assert.equal(existsSync(resolve(root, path)), true, `required path is missing: ${path}`);
}

for (const path of forbiddenPaths) {
  assert.equal(existsSync(resolve(root, path)), false, `forbidden path returned: ${path}`);
}

for (const entry of requiredText) {
  assert.equal(typeof entry?.path, "string", true, "required_text.path must be a string");
  assert.ok(Array.isArray(entry?.tokens), `required_text.tokens must be an array for ${entry?.path}`);
  const text = readFileSync(resolve(root, entry.path), "utf8");
  for (const token of entry.tokens) {
    assert.equal(text.includes(token), true, `${entry.path} must contain ${JSON.stringify(token)}`);
  }
}

for (const entry of forbiddenText) {
  assert.equal(typeof entry?.path, "string", true, "forbidden_text.path must be a string");
  assert.ok(Array.isArray(entry?.tokens), `forbidden_text.tokens must be an array for ${entry?.path}`);
  const text = readFileSync(resolve(root, entry.path), "utf8");
  for (const token of entry.tokens) {
    assert.equal(text.includes(token), false, `${entry.path} contains forbidden token ${JSON.stringify(token)}`);
  }
}

console.log("Architectural constraints manifest passed");
