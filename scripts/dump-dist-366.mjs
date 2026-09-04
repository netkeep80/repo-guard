import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const paths = [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
];

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

for (const path of paths) {
  const content = readFileSync(path);
  console.log(`@@DIST-RAW-BASE64:${path}@@`);
  console.log(content.toString("base64"));
  console.log(`@@DIST-RAW-END:${path}@@`);
}
