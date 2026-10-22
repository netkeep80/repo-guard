#!/usr/bin/env node
// #801 project-owned renderer: generic RepoGuard build only validates/applies its bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProjectionModel, projectionModelIdentity } from "../dist/projection-model.mjs";
import { readOwnedMarkdownBlock } from "../dist/markdown-structure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const summaryId = "repo-guard.docs.self-host-summary";
const coverageId = "repo-guard.docs.self-host-coverage";
const contract = "repo-guard-doc-self-host/v1";
const tool = "repo-guard/docs-self-host@1";

function render() {
  const registry = JSON.parse(read("docs/self-hosting-coverage.json"));
  if (registry.schema_version !== "2.0.0" || !registry.exceptions ||
      typeof registry.exceptions !== "object" || Array.isArray(registry.exceptions)) {
    throw new Error("invalid canonical self-host exception registry");
  }
  const exceptions = Object.entries(registry.exceptions).sort(([a], [b]) => a.localeCompare(b, "en"));
  if (exceptions.some(([k, v]) => !k || typeof v !== "string" || !v.trim())) {
    throw new Error("invalid self-host exception");
  }
  const summary = "Исключения самоприменения: **" + exceptions.length +
    "**. Их основания находятся в [производном справочнике](docs/self-hosting-coverage.md); " +
    "исходные решения — в [JSON-реестре](docs/self-hosting-coverage.json).";
  const coverage = [
    "# Исключения самоприменения RepoGuard",
    "",
    "Этот справочник выводится из \x60docs/self-hosting-coverage.json\x60. Он не является отдельным источником полномочий или требований.",
    "",
    ...exceptions.flatMap(([key, reason]) => ["## " + String.fromCharCode(96) + key + String.fromCharCode(96), "", reason, ""]),
  ].join("\n") + "\n";
  return { [summaryId]: summary, [coverageId]: coverage };
}

function generatedFragment(model, payload) {
  if (model.target.ownership === "generated") return payload;
  const locator = model.target.locator;
  if (locator?.kind !== "markdown_owned_block") throw new Error("only exact owned blocks are supported");
  return [locator.begin_marker, payload.trimEnd(), locator.end_marker].join("\n");
}

function expectedState(outputs) {
  const current = JSON.parse(read(".repo-guard/projections.json"));
  if (current.schema !== "repo-guard/projection-check/v0" || !Array.isArray(current.entries)) {
    throw new Error("invalid self-host projection declaration");
  }
  return {
    schema: current.schema,
    entries: current.entries.map((record) => {
      if (record.state !== "live") return record;
      const model = normalizeProjectionModel(record.model);
      const payload = outputs[model.id];
      if (typeof payload !== "string") throw new Error("unknown documentation Projection " + model.id);
      const output = generatedFragment(model, payload);
      return {
        state: "live", model,
        build: {
          schema: "repo-guard/projection-build-record/v0",
          projection_id: model.id,
          model_identity: projectionModelIdentity(model),
          source_identities: model.sources.map((source) => {
            if (source.kind !== "repository_content") throw new Error("unsupported project renderer source");
            return { source_id: source.id, algorithm: "sha256", digest: digest(read(source.path)) };
          }),
          generator: { contract_id: model.generator.contract_id, tool_identity: tool },
          configuration_digest: digest(contract),
          output_identity: { algorithm: "sha256", digest: digest(output) },
          evidence: [],
        },
        current_generator: { tool_identity: tool, configuration_digest: digest(contract) },
      };
    }),
  };
}

function verify(outputs) {
  const declared = JSON.parse(read(".repo-guard/projections.json"));
  const expected = expectedState(outputs);
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new Error("stale self-host Projection BuildRecord; regenerate --state");
  }
  for (const record of expected.entries) {
    if (record.state !== "live") continue;
    const payload = outputs[record.model.id];
    let observed;
    if (record.model.target.ownership === "generated") observed = read(record.model.target.path);
    else {
      const locator = record.model.target.locator;
      const block = readOwnedMarkdownBlock(read(record.model.target.path), {
        blockId: locator.block_id, beginMarker: locator.begin_marker, endMarker: locator.end_marker,
      });
      observed = block?.content ?? null;
    }
    if (observed !== generatedFragment(record.model, payload)) {
      throw new Error("stale owned documentation bytes: " + record.model.target.path);
    }
  }
}

const outputs = render();
const command = process.argv[2] || "--outputs";
if (command === "--outputs") process.stdout.write(JSON.stringify(outputs) + "\n");
else if (command === "--state") process.stdout.write(JSON.stringify(expectedState(outputs), null, 2) + "\n");
else if (command === "--check") {
  verify(outputs);
  console.log("Real RepoGuard documentation projections: CURRENT");
} else throw new Error("Expected --outputs, --state or --check");
