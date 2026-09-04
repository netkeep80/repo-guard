import { execFileSync } from "node:child_process";

const paths = [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
];

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log("@@DIST-DIFF-BEGIN@@");
process.stdout.write(execFileSync("git", ["diff", "--no-ext-diff", "--unified=3", "--", ...paths], { encoding: "utf-8" }));
console.log("@@DIST-DIFF-END@@");
