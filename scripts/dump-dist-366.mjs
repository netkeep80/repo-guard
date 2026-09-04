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

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

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
  console.log(
    `::notice title=DIST366-${index + 1}-of-${chunks.length}::${chunks[index]}`,
  );
}
