import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root=resolve(new URL("..",import.meta.url).pathname);
const read=(path)=>readFileSync(resolve(root,path),"utf8");
const requirement=(id)=>parse(read("requirements/repo-guard/"+id+".rg.yaml"));
const triples=(id)=>(requirement(id).relations||[]).flatMap((relation)=>
  (relation.predicates||[]).map((predicate)=>predicate+" -> "+relation.target?.path));

const absent=[
  ["RG-01","verified_by -> tests/test-security-brace-expansion.mjs"],
  ["RG-01","verified_by -> tests/test-security-fast-uri.mjs"],
  ["RG-03","implemented_by -> src/diff/filters.mts"],
  ["RG-03","implemented_by -> dist/diff/filters.mjs"],
  ["RG-03","implemented_by -> src/diff/growth.mts"],
  ["RG-03","implemented_by -> dist/diff/growth.mjs"],
  ["RG-06","documents -> LICENSE"],
  ["RG-06","implemented_by -> package-lock.json"],
  ["RG-08","implemented_by -> .gitignore"],
  ["RG-08","verified_by -> tests/run.mjs"],
  ["RG-08","verified_by -> tests/support/run-cli.mjs"],
  ["RG-08","implemented_by -> tsconfig.json"],
];
for(const [id,triple] of absent){
  assert.equal(triples(id).includes(triple),false,"known false relation returned: "+id+" "+triple);
}

const present=[
  ["RG-04","implemented_by -> .gitignore"],
  ["RG-04","implemented_by -> tests/run.mjs"],
  ["RG-04","verified_by -> tests/test-824-semantic-adequacy.mjs"],
  ["RG-05","implemented_by -> package-lock.json"],
  ["RG-05","implemented_by -> tsconfig.json"],
  ["RG-05","verified_by -> tests/test-security-brace-expansion.mjs"],
  ["RG-05","verified_by -> tests/test-security-fast-uri.mjs"],
  ["RG-09","implemented_by -> package.json"],
  ["RG-09","documents -> LICENSE"],
  ["RG-09","verified_by -> tests/test-rg09-distribution-license.mjs"],
  ["RG-09","documents -> README.md"],
];
for(const [id,triple] of present){
  assert.equal(triples(id).includes(triple),true,"corrected relation missing: "+id+" "+triple);
}

for(const path of [
  "src/diff/filters.mts","dist/diff/filters.mjs",
  "src/diff/growth.mts","dist/diff/growth.mjs",
  "tests/support/run-cli.mjs",
]){
  assert.equal(existsSync(resolve(root,path)),false,"obsolete resource returned: "+path);
}

const ci=read(".github/workflows/ci.yml");
const ignore=read(".gitignore");
assert.match(ci,/npm ci/);
assert.match(ci,/git status --porcelain/);
assert.match(ignore,/^node_modules\/$/m);
assert.match(ignore,/^\*\.tgz$/m);

const runner=read("tests/run.mjs");
assert.match(runner,/\^test-\.\*\\\.mjs\$/);
assert.match(runner,/process\.exit/);

const build=read("scripts/build.mjs");
const checkDist=read("scripts/check-dist.mjs");
assert.match(build,/tsconfig\.json/);
assert.match(checkDist,/cleanBuild\(\)/);

const brace=read("tests/test-security-brace-expansion.mjs");
const fast=read("tests/test-security-fast-uri.mjs");
for(const evidence of [brace,fast]){
  assert.match(evidence,/package-lock\.json/);
  assert.match(evidence,/resolved/);
  assert.match(evidence,/integrity/);
}

console.log("#824 concrete semantic-adequacy ratchet passed");
