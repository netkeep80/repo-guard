import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

for (const path of [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
]) {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const payload = gzipSync(bytes, { level: 9 }).toString("base64");
  console.log(`@@DIST-GZIP-BASE64:${path}:${bytes.length}:${sha256}@@`);
  console.log(payload);
}
