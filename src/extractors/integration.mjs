import { createDocumentReader, parseJson, parseMarkdown, parseYaml } from "../document-facts.mjs";
import { uniqueSorted } from "../utils/collections.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeValue(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  return JSON.stringify(value);
}

function normalizeMap(value) {
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeValue(item)]));
}

function extractTriggerEvents(onValue) {
  if (typeof onValue === "string") return [onValue];
  if (Array.isArray(onValue)) return onValue.filter((item) => item != null).map(normalizeValue);
  return isPlainObject(onValue) ? Object.keys(onValue) : [];
}

function extractTriggerEventTypes(onValue) {
  if (!isPlainObject(onValue)) return [];
  return Object.entries(onValue).flatMap(([event, config]) => {
    if (!isPlainObject(config) || !Object.hasOwn(config, "types")) return [];
    const types = (Array.isArray(config.types) ? config.types : [config.types]).filter((item) => item != null).map(normalizeValue);
    return types.length ? [{ event, types }] : [];
  });
}

function collectEnvVars(value, scope, extra = {}) {
  const env = normalizeMap(value);
  return env ? Object.entries(env).map(([name, item]) => ({ scope, ...extra, name, value: item })) : [];
}

function detectSummaryPublishingMode(run) {
  if (run == null || !String(run).includes("GITHUB_STEP_SUMMARY")) return null;
  const text = String(run);
  const target = String.raw`["']?\$?\{?GITHUB_STEP_SUMMARY\}?["']?`;
  if (new RegExp(`>>\\s*${target}`).test(text) || new RegExp(`GITHUB_STEP_SUMMARY[^\\n]*>>`).test(text)) return "append";
  if (new RegExp(`(^|[^>])>\\s*${target}`).test(text) || new RegExp(`GITHUB_STEP_SUMMARY[^\\n]*(^|[^>])>`).test(text)) return "write";
  return "mentions";
}

function collectWorkflowFacts(entry, content) {
  const data = parseYaml(content);
  if (!isPlainObject(data)) throw new Error("workflow YAML must be a mapping");
  const jobs = isPlainObject(data.jobs) ? data.jobs : {};
  const actionUses = [];
  const stepInputs = [];
  const envVars = collectEnvVars(data.env, "workflow");
  const ifConditions = [];
  const runCommands = [];
  const summaryPublishing = [];
  const continueOnError = [];
  const jobPermissions = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    const permission = normalizeMap(job.permissions);
    if (permission || typeof job.permissions === "string") jobPermissions.push({ jobId, permissions: permission || job.permissions });
    envVars.push(...collectEnvVars(job.env, "job", { jobId }));
    if (job.if !== undefined) ifConditions.push({ scope: "job", jobId, condition: normalizeValue(job.if) });
    if (job["continue-on-error"] !== undefined) continueOnError.push({ scope: "job", jobId, value: normalizeValue(job["continue-on-error"]) });
    if (job.uses !== undefined) {
      const uses = normalizeValue(job.uses);
      actionUses.push({ scope: "job", jobId, uses });
      const inputs = normalizeMap(job.with);
      if (inputs) stepInputs.push({ scope: "job", jobId, uses, inputs });
    }
    if (!Array.isArray(job.steps)) continue;
    for (const [offset, step] of job.steps.entries()) {
      if (!isPlainObject(step)) continue;
      const base = { jobId, stepIndex: offset + 1 };
      if (step.name) base.stepName = normalizeValue(step.name);
      if (step.uses !== undefined) {
        const uses = normalizeValue(step.uses);
        actionUses.push({ ...base, uses });
        const inputs = normalizeMap(step.with);
        if (inputs) stepInputs.push({ ...base, uses, inputs });
      }
      envVars.push(...collectEnvVars(step.env, "step", base));
      if (step.if !== undefined) ifConditions.push({ scope: "step", ...base, condition: normalizeValue(step.if) });
      if (step["continue-on-error"] !== undefined) continueOnError.push({ ...base, value: normalizeValue(step["continue-on-error"]) });
      if (step.run !== undefined) runCommands.push({ ...base, run: normalizeValue(step.run) });
      const summary = detectSummaryPublishingMode(step.run);
      if (summary) summaryPublishing.push({ ...base, mode: summary });
    }
  }

  return {
    id: entry.id, kind: entry.kind, path: entry.path, role: entry.role, expect: entry.expect || null,
    triggerEvents: extractTriggerEvents(data.on), triggerEventTypes: extractTriggerEventTypes(data.on),
    permissions: { workflow: normalizeMap(data.permissions) || (typeof data.permissions === "string" ? data.permissions : null), jobs: jobPermissions },
    actionUses, stepInputs, envVars, ifConditions, runCommands, summaryPublishing, continueOnError,
  };
}

function publicCodeBlock(block) {
  return { language: block.language, infoString: block.infoString, startLine: block.startLine, endLine: block.endLine };
}

function fieldPathsFromObject(value, prefix = "") {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).sort().flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...fieldPathsFromObject(value[key], path)];
  });
}

function parseContractBlock(block) {
  try {
    const data = block.language === "repo-guard-json" ? parseJson(block.content) : parseYaml(block.content);
    return { ok: true, fieldNames: isPlainObject(data) ? Object.keys(data).sort() : [], fieldPaths: uniqueSorted(fieldPathsFromObject(data)) };
  } catch (error) {
    return { ok: false, message: `invalid ${block.language} block at line ${block.startLine}: ${error.message}` };
  }
}

function extractContractBlocks(markdown) {
  const blocks = [];
  const errors = [];
  for (const block of markdown.codeBlocks.filter((item) => ["repo-guard-yaml", "repo-guard-json"].includes(item.language))) {
    const parsed = parseContractBlock(block);
    blocks.push({
      format: block.language, startLine: block.startLine, endLine: block.endLine, ok: parsed.ok,
      fieldNames: parsed.fieldNames || [], fieldPaths: parsed.fieldPaths || [],
    });
    if (!parsed.ok) errors.push({ message: parsed.message });
  }
  return { blocks, errors };
}

function templateFactFromMarkdown(entry, markdown) {
  const { blocks, errors } = extractContractBlocks(markdown);
  return {
    fact: {
      id: entry.id, kind: entry.kind, path: entry.path, present: true, optional: Boolean(entry.optional),
      requiresContractBlock: Boolean(entry.requires_contract_block), requiredBlockKind: entry.required_block_kind || null,
      requiredContractFields: entry.required_contract_fields || [],
      hasRepoGuardYamlBlock: blocks.some((block) => block.format === "repo-guard-yaml"),
      hasRepoGuardJsonBlock: blocks.some((block) => block.format === "repo-guard-json"),
      contractBlocks: blocks, contractFieldNames: uniqueSorted(blocks.flatMap((block) => block.fieldPaths)),
      headings: markdown.headings, codeBlocks: markdown.codeBlocks.map(publicCodeBlock),
    }, errors,
  };
}

function collectStringValues(value, sourcePath = "$") {
  if (typeof value === "string") return [{ sourcePath, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStringValues(item, `${sourcePath}[${index}]`));
  return isPlainObject(value) ? Object.entries(value).flatMap(([key, item]) => collectStringValues(item, `${sourcePath}.${key}`)) : [];
}

function collectIssueFormTemplateFacts(entry, content) {
  const blocks = [];
  const errors = [];
  for (const source of collectStringValues(parseYaml(content))) {
    const markdown = parseMarkdown(source.value);
    errors.push(...markdown.errors.map((error) => ({ message: `${source.sourcePath}: ${error.message}` })));
    const extracted = extractContractBlocks(markdown);
    blocks.push(...extracted.blocks.map((block) => ({ ...block, sourcePath: source.sourcePath })));
    errors.push(...extracted.errors.map((error) => ({ message: `${source.sourcePath}: ${error.message}` })));
  }
  return {
    fact: {
      id: entry.id, kind: entry.kind, path: entry.path, present: true, optional: Boolean(entry.optional),
      requiresContractBlock: Boolean(entry.requires_contract_block), requiredBlockKind: entry.required_block_kind || null,
      requiredContractFields: entry.required_contract_fields || [],
      hasRepoGuardYamlBlock: blocks.some((block) => block.format === "repo-guard-yaml"),
      hasRepoGuardJsonBlock: blocks.some((block) => block.format === "repo-guard-json"),
      contractBlocks: blocks, contractFieldNames: uniqueSorted(blocks.flatMap((block) => block.fieldPaths)),
    }, errors,
  };
}

function missingOptionalTemplateFact(entry) {
  return {
    id: entry.id, kind: entry.kind, path: entry.path, present: false, optional: true,
    requiresContractBlock: Boolean(entry.requires_contract_block), requiredBlockKind: entry.required_block_kind || null,
    requiredContractFields: entry.required_contract_fields || [], hasRepoGuardYamlBlock: false, hasRepoGuardJsonBlock: false,
    contractBlocks: [], contractFieldNames: [], headings: [], codeBlocks: [],
  };
}

function collectTemplateFacts(entry, content, markdown = null) {
  if (entry.kind === "github_issue_form") return collectIssueFormTemplateFacts(entry, content);
  const parsed = markdown || parseMarkdown(content);
  const result = templateFactFromMarkdown(entry, parsed);
  result.errors.push(...parsed.errors);
  return result;
}

function findLiteralOccurrences(content, term) {
  if (!term) return [];
  const needle = String(term).toLowerCase();
  const locations = [];
  for (const [offset, line] of String(content || "").split(/\r?\n/).entries()) {
    const haystack = line.toLowerCase();
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      locations.push({ line: offset + 1, column: index + 1 });
      index += Math.max(needle.length, 1);
    }
  }
  return locations;
}

function mentionFact(content, term) {
  const locations = findLiteralOccurrences(content, term);
  return { term, present: locations.length > 0, count: locations.length, locations };
}

function collectDocFacts(entry, content, markdown) {
  return {
    fact: {
      id: entry.id, path: entry.path, headings: markdown.headings, codeBlocks: markdown.codeBlocks.map(publicCodeBlock),
      hasCodeBlocks: markdown.codeBlocks.length > 0,
      mentions: (entry.must_mention || []).map((term) => mentionFact(content, term)),
      fileReferences: (entry.must_reference_files || []).map((term) => mentionFact(content, term)),
      profileMentions: (entry.must_mention_profiles || []).map((term) => mentionFact(content, term)),
      contractFieldMentions: (entry.must_mention_contract_fields || []).map((term) => mentionFact(content, term)),
    }, errors: markdown.errors,
  };
}

function collectRegexFacts(content, regexes) {
  const facts = [];
  const seen = new Set();
  for (const [offset, line] of String(content || "").split(/\r?\n/).entries()) {
    for (const source of regexes) {
      const regex = new RegExp(source.source, source.flags.includes("g") ? source.flags : `${source.flags}g`);
      let match;
      while ((match = regex.exec(line)) !== null) {
        const value = match[1];
        if (!value) continue;
        const column = match.index + match[0].lastIndexOf(value) + 1;
        const key = `${value}:${offset + 1}:${column}`;
        if (!seen.has(key)) {
          seen.add(key);
          facts.push({ value, line: offset + 1, column });
        }
      }
    }
  }
  return facts;
}

function profileReferenceFacts(content, profileId) {
  const values = uniqueSorted([profileId, String(profileId || "").replace(/[-_.]+/g, " ").trim()].filter(Boolean));
  const facts = [];
  const seen = new Set();
  for (const value of values) {
    for (const location of findLiteralOccurrences(content, value)) {
      const key = `${profileId}:${location.line}:${location.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        facts.push({ value: profileId, ...location });
      }
    }
  }
  return facts.sort((a, b) => a.line - b.line || a.column - b.column || a.value.localeCompare(b.value));
}

function collectProfileFacts(entry, content, markdown) {
  return {
    fact: {
      id: entry.id, docPath: entry.doc_path, headings: markdown.headings, codeBlocks: markdown.codeBlocks.map(publicCodeBlock),
      identifiers: collectRegexFacts(content, [
        /\bprofile[ _-]?id\b\s*[:=]\s*`?([A-Za-z0-9_.-]+)/i,
        /\bprofile\b\s*[:=]\s*`?([A-Za-z0-9_.-]+)/i,
      ]),
      migrationTargets: collectRegexFacts(content, [
        /\bmigration[ _-]?target\b\s*[:=]\s*`?([A-Za-z0-9_.-]+)/i,
        /\bmigrat(?:e|es|ed|ing)\s+to\s+`?([A-Za-z0-9_.-]+)/i,
      ]),
      profileNameReferences: profileReferenceFacts(content, entry.id),
    }, errors: markdown.errors,
  };
}

function compareErrors(a, b) {
  return a.section.localeCompare(b.section) || (a.path || "").localeCompare(b.path || "") ||
    (a.id || "").localeCompare(b.id || "") || a.message.localeCompare(b.message);
}

function withErrorContext(section, entry, message) {
  return { section, id: entry.id, kind: entry.kind, path: entry.path || entry.doc_path, message };
}

function isMissingRepositoryFileError(error, entry) {
  const message = String(error?.message || "");
  return error?.code === "ENOENT" || message.includes("ENOENT") || message.includes("no such file or directory") ||
    message === `cannot read ${entry.path}` || message.includes(`missing fixture ${entry.path}`);
}

export function extractIntegration(policy, options = {}) {
  const integration = policy.integration;
  const result = { workflows: [], templates: [], docs: [], profiles: [], errors: [] };
  if (!integration) return result;
  const documents = options.documents || createDocumentReader(options);

  for (const entry of integration.workflows || []) {
    try {
      result.workflows.push(collectWorkflowFacts(entry, documents.text(entry.path)));
    } catch (error) {
      result.errors.push(withErrorContext("workflows", entry, error.message));
    }
  }
  for (const entry of integration.templates || []) {
    try {
      const content = documents.text(entry.path);
      const extracted = collectTemplateFacts(entry, content, entry.kind === "markdown" ? documents.markdown(entry.path) : null);
      result.templates.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("templates", entry, error.message)));
    } catch (error) {
      if (entry.optional === true && isMissingRepositoryFileError(error, entry)) result.templates.push(missingOptionalTemplateFact(entry));
      else result.errors.push(withErrorContext("templates", entry, error.message));
    }
  }
  for (const entry of integration.docs || []) {
    try {
      const extracted = collectDocFacts(entry, documents.text(entry.path), documents.markdown(entry.path));
      result.docs.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("docs", entry, error.message)));
    } catch (error) {
      result.errors.push(withErrorContext("docs", entry, error.message));
    }
  }
  for (const entry of integration.profiles || []) {
    try {
      const extracted = collectProfileFacts(entry, documents.text(entry.doc_path), documents.markdown(entry.doc_path));
      result.profiles.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("profiles", entry, error.message)));
    } catch (error) {
      result.errors.push(withErrorContext("profiles", entry, error.message));
    }
  }
  result.errors.sort(compareErrors);
  return result;
}
