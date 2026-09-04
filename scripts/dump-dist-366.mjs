import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const paths = [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
];

execFileSync("npm", ["run", "build"], { stdio: "pipe" });
const patch = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--unified=3", "--", ...paths],
  { encoding: "utf8" },
);
if (!patch) {
  throw new Error("expected generated dist diff");
}
const encoded = gzipSync(Buffer.from(patch, "utf8"), { level: 9 }).toString(
  "base64",
);
const chunkSize = 6000;
const chunks = [];
for (let offset = 0; offset < encoded.length; offset += chunkSize) {
  chunks.push(encoded.slice(offset, offset + chunkSize));
}
for (let index = 0; index < chunks.length; index += 1) {
  console.log(`@@DIST366-PATCH-GZIP-BASE64:${index + 1}/${chunks.length}@@${chunks[index]}`);
}

process.exitCode = 1;
