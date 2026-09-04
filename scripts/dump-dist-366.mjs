import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

for (const path of [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
]) {
  console.log(`@@DIST-BEGIN:${path}@@`);
  process.stdout.write(readFileSync(path, "utf-8"));
  console.log(`@@DIST-END:${path}@@`);
}
