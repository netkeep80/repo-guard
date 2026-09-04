import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const paths = [
  "dist/facts/input.mjs",
  "dist/check-diff.mjs",
  "dist/checks/constraint-program.mjs",
  "dist/checks/rules/constraints.mjs",
  "dist/github-pr.mjs",
];

execFileSync("npm", ["run", "build"], { stdio: "pipe" });

const payload = Object.fromEntries(
  paths.map((path) => [path, readFileSync(path, "utf8")]),
);
const encoded = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), {
  level: 9,
}).toString("base64");
const chunkSize = 6000;
const chunks = [];
for (let offset = 0; offset < encoded.length; offset += chunkSize) {
  chunks.push(encoded.slice(offset, offset + chunkSize));
}
for (let index = 0; index < chunks.length; index += 1) {
  console.log(`@@DIST366-GZIP-BASE64:${index + 1}/${chunks.length}@@${chunks[index]}`);
}

process.exitCode = 1;
