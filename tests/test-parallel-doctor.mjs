import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(projectRoot, "dist/repo-guard.mjs");
let failures = 0;

function expect(label, actual, expected) {
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectIncludes(label, actual, expected) {
  const passed = actual.includes(expected);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected to include: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function expectNotIncludes(label, actual, expected) {
  const passed = !actual.includes(expected);
  console.log(`${passed ? "PASS" : "FAIL"}: ${label}`);
  if (!passed) {
    failures++;
    console.error(`  expected not to include: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    env: process.env,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

console.log("\n--- doctor --parallel requires an explicit provider value ---");
{
  const result = run(["doctor", "--parallel"]);
  expect("missing provider exits non-zero", result.code, 1);
  expectIncludes("parallel option is recognized as value-taking", result.stderr, "--parallel requires a value");
  expectNotIncludes("parallel option is not rejected as unknown", result.stderr, "Unknown option for doctor: --parallel");
}

console.log("\n--- doctor --parallel rejects unsupported providers ---");
{
  const result = run(["doctor", "--parallel", "bogus"]);
  expect("unsupported provider exits non-zero", result.code, 1);
  expectIncludes("unsupported provider is explicit", result.stderr, "Unsupported parallel provider: bogus");
}

console.log("\n=========================");
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("All parallel doctor tests passed");
