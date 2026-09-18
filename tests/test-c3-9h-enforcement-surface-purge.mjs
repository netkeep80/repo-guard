import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeEnforcementMode } from "../dist/enforcement.mjs";
import { runCliCaptured } from "./support/run-cli.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const immutableSha = "0123456789abcdef0123456789abcdef01234567";

function temp() {
  return mkdtempSync(join(tmpdir(), "repo-guard-c39h-"));
}

async function init(mode) {
  const dir = temp();
  const result = await runCliCaptured([
    "--repo-root", dir,
    "init",
    "--action-ref", immutableSha,
    "--mode", mode,
  ]);
  return { dir, result };
}

console.log("\n--- canonical runtime enforcement vocabulary ---");
for (const mode of ["advisory", "blocking"]) {
  assert.deepEqual(normalizeEnforcementMode(mode), { ok: true, mode });
}
for (const alias of ["warn", "enforce"]) {
  const result = normalizeEnforcementMode(alias);
  assert.equal(result.ok, false, `${alias} must be rejected`);
  assert.match(result.message, /Must be one of: advisory, blocking\./);
}

console.log("\n--- hidden global option alias is rejected ---");
{
  const result = await runCliCaptured(["--enforcement-mode", "advisory", "validate"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /Unknown option: --enforcement-mode/);
}

console.log("\n--- init keeps --mode but only canonical values ---");
for (const mode of ["advisory", "blocking"]) {
  const { dir, result } = await init(mode);
  assert.equal(result.code, 0, `${mode} must remain accepted by init --mode`);
  const policy = JSON.parse(readFileSync(join(dir, "repo-policy.json"), "utf-8"));
  assert.equal(policy.enforcement.mode, mode);
  rmSync(dir, { recursive: true });
}
for (const alias of ["warn", "enforce"]) {
  const { dir, result } = await init(alias);
  assert.equal(result.code, 1, `${alias} must be rejected by init --mode`);
  assert.match(result.output, /Must be one of: advisory, blocking\./);
  rmSync(dir, { recursive: true });
}

console.log("\n--- Action and schema expose one vocabulary ---");
{
  const action = readFileSync(resolve(root, "action.yml"), "utf-8");
  assert.doesNotMatch(action, /`warn`/);
  assert.doesNotMatch(action, /`enforce`/);
  assert.match(action, /`advisory`/);
  assert.match(action, /`blocking`/);

  const schema = JSON.parse(readFileSync(resolve(root, "schemas/repo-policy.schema.json"), "utf-8"));
  assert.deepEqual(schema.properties.enforcement.properties.mode.enum, ["advisory", "blocking"]);
}

console.log("C3.9h canonical enforcement surface ratchet passed.");
