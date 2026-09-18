import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDir, "..");
const helperPath = join(testsDir, "support", "run-cli.mjs");
let failures = 0;

function expect(label, condition) {
  const ok = Boolean(condition);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures++;
}

expect("shared runCli capture helper exists", existsSync(helperPath));

const targets = [
  "test-repo-root.mjs",
  "test-enforcement-mode.mjs",
  "test-structured-output.mjs",
  "test-self-hosting.mjs",
];

for (const name of targets) {
  const source = readFileSync(join(testsDir, name), "utf-8");
  expect(`${name} reuses shared runCli helper`, source.includes('./support/run-cli.mjs'));
  expect(`${name} has no local direct repo-guard process wrapper`,
    !source.includes("spawnSync(process.execPath, [repoGuard")
      && !source.includes('`node dist/repo-guard.mjs')
      && !source.includes('`node ${resolve(projectRoot, "dist/repo-guard.mjs")}'));
}

if (existsSync(helperPath)) {
  const { runCliCaptured } = await import("./support/run-cli.mjs");

  const success = await runCliCaptured(["--repo-root", projectRoot]);
  expect("helper preserves successful exit code", success.code === 0);
  expect("helper captures stdout", success.stdout.includes("OK: repo-policy.json"));

  const failure = await runCliCaptured(["--unknown-flag"]);
  expect("helper preserves failing exit code", failure.code === 1);
  expect("helper captures stderr", failure.stderr.includes("Unknown option: --unknown-flag"));

  const originalEventPath = process.env.GITHUB_EVENT_PATH;
  const missingEventPath = join(tmpdir(), "repo-guard-c3-8i-missing-event.json");
  const overridden = await runCliCaptured(["check-pr"], {
    env: { GITHUB_EVENT_PATH: missingEventPath },
  });
  expect("helper applies scoped env override", overridden.stderr.includes(missingEventPath));
  expect("helper restores existing env after override", process.env.GITHUB_EVENT_PATH === originalEventPath);

  const absentKey = "REPO_GUARD_C3_8I_ABSENT_ENV";
  delete process.env[absentKey];
  await runCliCaptured(["--unknown-flag"], { env: { [absentKey]: "temporary" } });
  expect("helper restores previously absent env", process.env[absentKey] === undefined);
}

if (failures) {
  console.error(`\n${failures} C3.8i harness contract check(s) failed`);
  process.exit(1);
}
console.log("\nC3.8i CLI harness compression contract passed");
