import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg=JSON.parse(readFileSync(resolve("package.json"),"utf8"));
const license=readFileSync(resolve("LICENSE"),"utf8");

assert.equal(pkg.license,"Unlicense","published package metadata must declare the accepted Unlicense");
assert.ok(pkg.files?.includes("LICENSE"),"published package file set must include LICENSE");
assert.match(license,/free and unencumbered software released into the public domain/i);
assert.match(license,/https:\/\/unlicense\.org/);

console.log("RG-09 distribution license contract passed");
