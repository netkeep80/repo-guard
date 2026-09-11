import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import Ajv from "ajv";

const root = resolve(new URL("..", import.meta.url).pathname);
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf-8"));

describe("C3.9a final public policy surface purge", () => {
  it("removes paths.public_api from the public schema and rejects it", () => {
    const schema = json("schemas/repo-policy.schema.json");
    assert.equal(schema.properties.paths.properties.public_api, undefined);

    const validate = new Ajv({ allErrors: true }).compile(schema);
    const policy = json("tests/fixtures/valid-policy.json");
    policy.paths = { ...policy.paths, public_api: ["src/**"] };
    assert.equal(validate(policy), false);
  });

  it("removes the reserved-field compatibility warning path", () => {
    const compiler = readFileSync(resolve(root, "src/policy-compiler.mts"), "utf-8");
    const validation = readFileSync(resolve(root, "src/runtime/validation.mts"), "utf-8");
    assert.doesNotMatch(compiler, /warnReservedPolicyFields|public_api/);
    assert.doesNotMatch(validation, /warnReservedPolicyFields/);
  });

  it("keeps schema descriptions about the current contract only", () => {
    const text = readFileSync(resolve(root, "schemas/repo-policy.schema.json"), "utf-8");
    assert.doesNotMatch(text, /Replaces the deprecated|in v1|Reserved for future use/);
  });
});
