import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { renderInitScaffold } from "../dist/init.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
const scaffold = renderInitScaffold({
  preset: "application",
  mode: "blocking",
  actionRef: "0123456789abcdef0123456789abcdef01234567",
});
const workflow = scaffold[".github/workflows/repo-guard.yml"];

describe("C3.9f single consumer scaffold authority", () => {
  it("ships no static duplicate scaffold corpus", () => {
    assert.equal(existsSync(resolve(root, "templates")), false, "templates/ must not ship beside executable init scaffold");
    assert.equal(
      existsSync(resolve(root, "examples/replace-custom-validator-workflow.yml")),
      false,
      "static workflow replacement example must not duplicate init output",
    );
    assert.equal(packageJson.files.includes("templates/"), false, "package must not publish removed static templates");
  });

  it("generates the current checkout and explicit permissions boundary", () => {
    assert.match(workflow, /uses: actions\/checkout@v6/);
    assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: read\n  issues: read/);
    assert.match(workflow, /fetch-depth: 0/);
    assert.doesNotMatch(workflow, /actions\/checkout@v4/);
  });
});
