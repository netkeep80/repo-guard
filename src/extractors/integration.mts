import type { DocumentReader, DocumentReaderOptions, MarkdownCodeBlock, MarkdownDocument } from "../document-facts.mjs";
import { createDocumentReader, parseJson, parseMarkdown, parseYaml } from "../document-facts.mjs";
import { uniqueSorted } from "../utils/collections.mjs";

type PlainObject = Record<string, unknown>;
type IntegrationSection = "workflows" | "templates" | "docs" | "profiles";

interface IntegrationEntryBase {
  id: string;
  kind?: string;
  path: string;
}

interface WorkflowEntry extends IntegrationEntryBase {
  role?: string;
  expect?: unknown;
}

interface TemplateEntry extends IntegrationEntryBase {
  kind: string;
  optional?: boolean;
  requires_change_intent_block?: boolean;
  required_block_kind?: string;
  required_change_intent_fields?: string[];
}

interface DocEntry extends IntegrationEntryBase {
  must_mention?: string[];
  must_reference_files?: string[];
  must_mention_profiles?: string[];
  must_mention_change_intent_fields?: string[];
}

interface ProfileEntry {
  id: string;
  kind?: string;
  doc_path: string;
}

interface IntegrationPolicyProjection {
  integration?: {
    workflows?: WorkflowEntry[];
    templates?: TemplateEntry[];
    docs?: DocEntry[];
    profiles?: ProfileEntry[];
  };
}

interface ExtractIntegrationOptions extends DocumentReaderOptions {
  documents?: DocumentReader;
}

interface FactLocation {
  scope?: string;
  jobId?: string;
  stepIndex?: number;
  stepName?: string;
}

interface ActionUseFact extends FactLocation { uses: string; }
interface StepInputFact extends ActionUseFact { inputs: Record<string, string>; }
interface EnvFact extends FactLocation { name: string; value: string; }
interface ConditionFact extends FactLocation { condition: string; }
interface RunCommandFact extends FactLocation { run: string; }
interface SummaryFact extends FactLocation { mode: string; }
interface ContinueOnErrorFact extends FactLocation { value: string; }
interface JobPermissionFact { jobId: string; permissions: Record<string, string> | string; }
interface EventTypesFact { event: string; types: string[]; }

export interface IntegrationWorkflowFact {
  id: string;
  kind?: string;
  path: string;
  role?: string;
  expect: unknown;
  triggerEvents: string[];
  triggerEventTypes: EventTypesFact[];
  permissions: { workflow: Record<string, string> | string | null; jobs: JobPermissionFact[] };
  actionUses: ActionUseFact[];
  stepInputs: StepInputFact[];
  envVars: EnvFact[];
  ifConditions: ConditionFact[];
  runCommands: RunCommandFact[];
  summaryPublishing: SummaryFact[];
  continueOnError: ContinueOnErrorFact[];
}

interface PublicCodeBlock {
  language: string;
  infoString: string;
  startLine: number;
  endLine: number;
}

interface ChangeIntentBlock {
  format: string;
  startLine: number;
  endLine: number;
  ok: boolean;
  fieldNames: string[];
  fieldPaths: string[];
  sourcePath?: string;
}

interface LocalError { message: string; }
interface LocationFact { line: number; column: number; }

export interface IntegrationTemplateFact {
  id: string;
  kind: string;
  path: string;
  present: boolean;
  optional: boolean;
  requiresChangeIntentBlock: boolean;
  requiredBlockKind: string | null;
  requiredChangeIntentFields: string[];
  hasRepoGuardYamlBlock: boolean;
  hasRepoGuardJsonBlock: boolean;
  changeIntentBlocks: ChangeIntentBlock[];
  changeIntentFieldNames: string[];
  headings?: MarkdownDocument["headings"];
  codeBlocks?: PublicCodeBlock[];
}

export interface IntegrationDocFact {
  id: string;
  path: string;
  headings: MarkdownDocument["headings"];
  codeBlocks: PublicCodeBlock[];
  hasCodeBlocks: boolean;
  mentions: Array<{ term: string; present: boolean; count: number; locations: LocationFact[] }>;
  fileReferences: Array<{ term: string; present: boolean; count: number; locations: LocationFact[] }>;
  profileMentions: Array<{ term: string; present: boolean; count: number; locations: LocationFact[] }>;
  changeIntentFieldMentions: Array<{ term: string; present: boolean; count: number; locations: LocationFact[] }>;
}

export interface IntegrationProfileFact {
  id: string;
  docPath: string;
  headings: MarkdownDocument["headings"];
  codeBlocks: PublicCodeBlock[];
  identifiers: Array<{ value: string; line: number; column: number }>;
  migrationTargets: Array<{ value: string; line: number; column: number }>;
  profileNameReferences: Array<{ value: string; line: number; column: number }>;
}

export interface IntegrationExtractionError {
  section: IntegrationSection;
  id: string;
  kind?: string;
  path: string;
  message: string;
}

export interface IntegrationExtraction {
  workflows: IntegrationWorkflowFact[];
  templates: IntegrationTemplateFact[];
  docs: IntegrationDocFact[];
  profiles: IntegrationProfileFact[];
  errors: IntegrationExtractionError[];
}

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  return JSON.stringify(value) as string;
}

function normalizeMap(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeValue(item)]));
}

function extractTriggerEvents(onValue: unknown): string[] {
  if (typeof onValue === "string") return [onValue];
  if (Array.isArray(onValue)) return onValue.filter((item) => item != null).map(normalizeValue);
  return isPlainObject(onValue) ? Object.keys(onValue) : [];
}

function extractTriggerEventTypes(onValue: unknown): EventTypesFact[] {
  if (!isPlainObject(onValue)) return [];
  return Object.entries(onValue).flatMap(([event, config]) => {
    if (!isPlainObject(config) || !Object.hasOwn(config, "types")) return [];
    const types = (Array.isArray(config.types) ? config.types : [config.types]).filter((item) => item != null).map(normalizeValue);
    return types.length ? [{ event, types }] : [];
  });
}

function collectEnvVars(value: unknown, scope: string, extra: FactLocation = {}): EnvFact[] {
  const env = normalizeMap(value);
  return env ? Object.entries(env).map(([name, item]) => ({ scope, ...extra, name, value: item })) : [];
}

function detectSummaryPublishingMode(run: unknown): string | null {
  if (run == null || !String(run).includes("GITHUB_STEP_SUMMARY")) return null;
  const text = String(run);
  const target = String.raw`["']?\$?\{?GITHUB_STEP_SUMMARY\}?["']?`;
  if (new RegExp(`>>\\s*${target}`).test(text) || new RegExp(`GITHUB_STEP_SUMMARY[^\\n]*>>`).test(text)) return "append";
  if (new RegExp(`(^|[^>])>\\s*${target}`).test(text) || new RegExp(`GITHUB_STEP_SUMMARY[^\\n]*(^|[^>])>`).test(text)) return "write";
  return "mentions";
}

function collectWorkflowFacts(entry: WorkflowEntry, content: string): IntegrationWorkflowFact {
  const data = parseYaml(content);
  if (!isPlainObject(data)) throw new Error("workflow YAML must be a mapping");
  const jobs = isPlainObject(data.jobs) ? data.jobs : {};
  const actionUses: ActionUseFact[] = [];
  const stepInputs: StepInputFact[] = [];
  const envVars = collectEnvVars(data.env, "workflow");
  const ifConditions: ConditionFact[] = [];
  const runCommands: RunCommandFact[] = [];
  const summaryPublishing: SummaryFact[] = [];
  const continueOnError: ContinueOnErrorFact[] = [];
  const jobPermissions: JobPermissionFact[] = [];

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
      const base: FactLocation = { jobId, stepIndex: offset + 1 };
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

function publicCodeBlock(block: MarkdownCodeBlock): PublicCodeBlock {
  return { language: block.language, infoString: block.infoString, startLine: block.startLine, endLine: block.endLine };
}

function fieldPathsFromObject(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).sort().flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...fieldPathsFromObject(value[key], path)];
  });
}

function parseChangeIntentBlock(block: MarkdownCodeBlock) {
  try {
    const data = block.language === "repo-guard-json" ? parseJson(block.content) : parseYaml(block.content);
    return { ok: true, fieldNames: isPlainObject(data) ? Object.keys(data).sort() : [], fieldPaths: uniqueSorted(fieldPathsFromObject(data)) };
  } catch (error: unknown) {
    return { ok: false, message: `invalid ${block.language} block at line ${block.startLine}: ${(error as Error).message}` };
  }
}

function extractChangeIntentBlocks(markdown: MarkdownDocument): { blocks: ChangeIntentBlock[]; errors: LocalError[] } {
  const blocks: ChangeIntentBlock[] = [];
  const errors: LocalError[] = [];
  for (const block of markdown.codeBlocks.filter((item) => ["repo-guard-yaml", "repo-guard-json"].includes(item.language))) {
    const parsed = parseChangeIntentBlock(block);
    blocks.push({
      format: block.language, startLine: block.startLine, endLine: block.endLine, ok: parsed.ok,
      fieldNames: parsed.fieldNames || [], fieldPaths: parsed.fieldPaths || [],
    });
    if (!parsed.ok) errors.push({ message: parsed.message as string });
  }
  return { blocks, errors };
}

function templateFactFromMarkdown(entry: TemplateEntry, markdown: MarkdownDocument) {
  const { blocks, errors } = extractChangeIntentBlocks(markdown);
  return {
    fact: {
      id: entry.id, kind: entry.kind, path: entry.path, present: true, optional: Boolean(entry.optional),
      requiresChangeIntentBlock: Boolean(entry.requires_change_intent_block), requiredBlockKind: entry.required_block_kind || null,
      requiredChangeIntentFields: entry.required_change_intent_fields || [],
      hasRepoGuardYamlBlock: blocks.some((block) => block.format === "repo-guard-yaml"),
      hasRepoGuardJsonBlock: blocks.some((block) => block.format === "repo-guard-json"),
      changeIntentBlocks: blocks, changeIntentFieldNames: uniqueSorted(blocks.flatMap((block) => block.fieldPaths)),
      headings: markdown.headings, codeBlocks: markdown.codeBlocks.map(publicCodeBlock),
    } satisfies IntegrationTemplateFact, errors,
  };
}

function collectStringValues(value: unknown, sourcePath = "$"): Array<{ sourcePath: string; value: string }> {
  if (typeof value === "string") return [{ sourcePath, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStringValues(item, `${sourcePath}[${index}]`));
  return isPlainObject(value) ? Object.entries(value).flatMap(([key, item]) => collectStringValues(item, `${sourcePath}.${key}`)) : [];
}

function collectIssueFormTemplateFacts(entry: TemplateEntry, content: string) {
  const blocks: ChangeIntentBlock[] = [];
  const errors: LocalError[] = [];
  for (const source of collectStringValues(parseYaml(content))) {
    const markdown = parseMarkdown(source.value);
    errors.push(...markdown.errors.map((error) => ({ message: `${source.sourcePath}: ${error.message}` })));
    const extracted = extractChangeIntentBlocks(markdown);
    blocks.push(...extracted.blocks.map((block) => ({ ...block, sourcePath: source.sourcePath })));
    errors.push(...extracted.errors.map((error) => ({ message: `${source.sourcePath}: ${error.message}` })));
  }
  return {
    fact: {
      id: entry.id, kind: entry.kind, path: entry.path, present: true, optional: Boolean(entry.optional),
      requiresChangeIntentBlock: Boolean(entry.requires_change_intent_block), requiredBlockKind: entry.required_block_kind || null,
      requiredChangeIntentFields: entry.required_change_intent_fields || [],
      hasRepoGuardYamlBlock: blocks.some((block) => block.format === "repo-guard-yaml"),
      hasRepoGuardJsonBlock: blocks.some((block) => block.format === "repo-guard-json"),
      changeIntentBlocks: blocks, changeIntentFieldNames: uniqueSorted(blocks.flatMap((block) => block.fieldPaths)),
    } satisfies IntegrationTemplateFact, errors,
  };
}

function missingOptionalTemplateFact(entry: TemplateEntry): IntegrationTemplateFact {
  return {
    id: entry.id, kind: entry.kind, path: entry.path, present: false, optional: true,
    requiresChangeIntentBlock: Boolean(entry.requires_change_intent_block), requiredBlockKind: entry.required_block_kind || null,
    requiredChangeIntentFields: entry.required_change_intent_fields || [], hasRepoGuardYamlBlock: false, hasRepoGuardJsonBlock: false,
    changeIntentBlocks: [], changeIntentFieldNames: [], headings: [], codeBlocks: [],
  };
}

function collectTemplateFacts(entry: TemplateEntry, content: string, markdown: MarkdownDocument | null = null) {
  if (entry.kind === "github_issue_form") return collectIssueFormTemplateFacts(entry, content);
  const parsed = markdown || parseMarkdown(content);
  const result = templateFactFromMarkdown(entry, parsed);
  result.errors.push(...parsed.errors);
  return result;
}

function findLiteralOccurrences(content: unknown, term: unknown): LocationFact[] {
  if (!term) return [];
  const needle = String(term).toLowerCase();
  const locations: LocationFact[] = [];
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

function mentionFact(content: unknown, term: string) {
  const locations = findLiteralOccurrences(content, term);
  return { term, present: locations.length > 0, count: locations.length, locations };
}

function collectDocFacts(entry: DocEntry, content: string, markdown: MarkdownDocument) {
  return {
    fact: {
      id: entry.id, path: entry.path, headings: markdown.headings, codeBlocks: markdown.codeBlocks.map(publicCodeBlock),
      hasCodeBlocks: markdown.codeBlocks.length > 0,
      mentions: (entry.must_mention || []).map((term) => mentionFact(content, term)),
      fileReferences: (entry.must_reference_files || []).map((term) => mentionFact(content, term)),
      profileMentions: (entry.must_mention_profiles || []).map((term) => mentionFact(content, term)),
      changeIntentFieldMentions: (entry.must_mention_change_intent_fields || []).map((term) => mentionFact(content, term)),
    } satisfies IntegrationDocFact, errors: markdown.errors,
  };
}

function collectRegexFacts(content: unknown, regexes: RegExp[]): Array<{ value: string; line: number; column: number }> {
  const facts: Array<{ value: string; line: number; column: number }> = [];
  const seen = new Set<string>();
  for (const [offset, line] of String(content || "").split(/\r?\n/).entries()) {
    for (const source of regexes) {
      const regex = new RegExp(source.source, source.flags.includes("g") ? source.flags : `${source.flags}g`);
      let match: RegExpExecArray | null;
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

function profileReferenceFacts(content: unknown, profileId: string): Array<{ value: string; line: number; column: number }> {
  const values = uniqueSorted([profileId, String(profileId || "").replace(/[-_.]+/g, " ").trim()].filter(Boolean));
  const facts: Array<{ value: string; line: number; column: number }> = [];
  const seen = new Set<string>();
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

function collectProfileFacts(entry: ProfileEntry, content: string, markdown: MarkdownDocument) {
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
    } satisfies IntegrationProfileFact, errors: markdown.errors,
  };
}

function compareErrors(a: IntegrationExtractionError, b: IntegrationExtractionError): number {
  return a.section.localeCompare(b.section) || (a.path || "").localeCompare(b.path || "") ||
    (a.id || "").localeCompare(b.id || "") || a.message.localeCompare(b.message);
}

function withErrorContext(section: IntegrationSection, entry: IntegrationEntryBase | ProfileEntry, message: string): IntegrationExtractionError {
  return { section, id: entry.id, kind: entry.kind, path: "path" in entry ? entry.path : entry.doc_path, message };
}

function isMissingRepositoryFileError(error: NodeJS.ErrnoException, entry: TemplateEntry): boolean {
  const message = String(error?.message || "");
  return error?.code === "ENOENT" || message.includes("ENOENT") || message.includes("no such file or directory") ||
    message === `cannot read ${entry.path}` || message.includes(`missing fixture ${entry.path}`);
}

export function extractIntegration(policy: IntegrationPolicyProjection, options: ExtractIntegrationOptions = {}): IntegrationExtraction {
  const integration = policy.integration;
  const result: IntegrationExtraction = { workflows: [], templates: [], docs: [], profiles: [], errors: [] };
  if (!integration) return result;
  const documents = options.documents || createDocumentReader(options);

  for (const entry of integration.workflows || []) {
    try {
      result.workflows.push(collectWorkflowFacts(entry, documents.text(entry.path)));
    } catch (error: unknown) {
      result.errors.push(withErrorContext("workflows", entry, (error as Error).message));
    }
  }
  for (const entry of integration.templates || []) {
    try {
      const content = documents.text(entry.path);
      const extracted = collectTemplateFacts(entry, content, entry.kind === "markdown" ? documents.markdown(entry.path) : null);
      result.templates.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("templates", entry, error.message)));
    } catch (error: unknown) {
      if (entry.optional === true && isMissingRepositoryFileError(error as NodeJS.ErrnoException, entry)) result.templates.push(missingOptionalTemplateFact(entry));
      else result.errors.push(withErrorContext("templates", entry, (error as Error).message));
    }
  }
  for (const entry of integration.docs || []) {
    try {
      const extracted = collectDocFacts(entry, documents.text(entry.path), documents.markdown(entry.path));
      result.docs.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("docs", entry, error.message)));
    } catch (error: unknown) {
      result.errors.push(withErrorContext("docs", entry, (error as Error).message));
    }
  }
  for (const entry of integration.profiles || []) {
    try {
      const extracted = collectProfileFacts(entry, documents.text(entry.doc_path), documents.markdown(entry.doc_path));
      result.profiles.push(extracted.fact);
      result.errors.push(...extracted.errors.map((error) => withErrorContext("profiles", entry, error.message)));
    } catch (error: unknown) {
      result.errors.push(withErrorContext("profiles", entry, (error as Error).message));
    }
  }
  result.errors.sort(compareErrors);
  return result;
}
