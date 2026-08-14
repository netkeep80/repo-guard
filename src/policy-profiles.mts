const PACKS = {
  "requirements-strict": {
    defaults: {
      requirement_globs: [
        "requirements/business/*.json",
        "requirements/stakeholder/*.json",
        "requirements/functional/*.json",
        "requirements/nonfunctional/*.json",
        "requirements/constraints/*.json",
        "requirements/interface/*.json",
      ],
      strict_heading_docs: [],
      evidence_surfaces: ["src/**", "tests/**", "experiments/**", "scripts/**", ".github/workflows/**"],
      affected_evidence_surfaces: [],
      implementation_surfaces: ["src/**", "scripts/**", ".github/workflows/**"],
      verification_surfaces: ["tests/**", "experiments/**", "scripts/**", ".github/workflows/**"],
    },
    anchors: {
      requirement_id: { kind: "json_field", globs: "$requirement_globs", field: "id" },
      code_req_ref: { kind: "regex", globs: ["src/**", "scripts/**"], pattern: "@req\\s+([A-Za-z][A-Za-z0-9_-]*-[0-9]+)" },
      test_req_ref: { kind: "regex", globs: ["tests/**", "experiments/**"], pattern: "\\[(?:REQ|req):?\\s*([A-Za-z][A-Za-z0-9_-]*-[0-9]+)\\]" },
      doc_req_ref: { kind: "regex", globs: ["docs/**/*.md", "README.md", "requirements/**/*.md"], pattern: "\\[([A-Za-z][A-Za-z0-9_-]*-[0-9]+)\\]" },
      doc_heading_req_ref: { kind: "regex", globs: "$strict_heading_docs", pattern: "^#{1,6}\\s+(?:\\[?([A-Za-z][A-Za-z0-9_-]*-[0-9]+)\\]?)(?:\\s|$)" },
    },
    trace_rules: [
      { id: "code-requirement-refs-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" },
      { id: "test-requirement-refs-resolve", kind: "must_resolve", from_anchor_type: "test_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-requirement-refs-resolve", kind: "must_resolve", from_anchor_type: "doc_req_ref", to_anchor_type: "requirement_id" },
      { id: "strict-doc-heading-refs-resolve", kind: "must_resolve", from_anchor_type: "doc_heading_req_ref", to_anchor_type: "requirement_id" },
      { id: "changed-requirements-need-evidence", kind: "changed_files_require_evidence", if_changed: "$requirement_globs", must_touch_any: "$evidence_surfaces" },
      { id: "declared-affected-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.affects", must_touch_any: "$affected_evidence_surfaces" },
      { id: "declared-implemented-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.implements", must_touch_any: "$implementation_surfaces" },
      { id: "declared-verified-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.verifies", must_touch_any: "$verification_surfaces" },
    ],
  },
} as const;

type ProfileConfig = Record<string, unknown>;
interface ProfileAnchorSpec {
  kind: "json_field" | "regex";
  globs: readonly string[] | string;
  field?: string;
  pattern?: string;
}
interface ProfileTraceRule {
  id: string;
  kind: string;
  if_changed?: unknown;
  must_touch_any?: unknown;
  [key: string]: unknown;
}
interface ProfileSpec {
  defaults: Readonly<Record<string, readonly string[]>>;
  anchors: Readonly<Record<string, ProfileAnchorSpec>>;
  trace_rules: readonly ProfileTraceRule[];
}
interface PolicyProjection extends Record<string, unknown> {
  profile?: unknown;
  profile_overrides?: unknown;
  anchors?: unknown;
  trace_rules?: unknown;
}
type ProfileCompileResult =
  | { ok: true; profile: null; config: null }
  | { ok: true; profile: string; config: ProfileConfig; spec: ProfileSpec }
  | { ok: false; error: string };

const clone = <T,>(value: T): T => structuredClone(value);
const isObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value);

function configFor(spec: ProfileSpec, overrides: unknown): ProfileConfig {
  const config = clone(spec.defaults) as ProfileConfig;
  if (!isObject(overrides)) return config;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!Object.hasOwn(spec.defaults, key)) throw new Error(`unknown profile_overrides key "${key}"`);
    config[key] = clone(value);
  }
  if (!config.affected_evidence_surfaces || !(config.affected_evidence_surfaces as unknown[]).length) config.affected_evidence_surfaces = clone(config.evidence_surfaces);
  return config;
}

function ref(value: unknown, config: ProfileConfig): unknown {
  if (typeof value === "string" && value.startsWith("$")) return clone(config[value.slice(1)] || []);
  return clone(value);
}

function materializeAnchor(spec: ProfileSpec, config: ProfileConfig) {
  const types: Record<string, { sources: Array<Record<string, unknown>> }> = {};
  for (const [name, source] of Object.entries(spec.anchors)) {
    const globs = ref(source.globs, config) as string[];
    const sources = globs.map((glob) => source.kind === "json_field"
      ? { kind: "json_field", glob, field: source.field }
      : { kind: "regex", glob, pattern: source.pattern });
    if (sources.length) types[name] = { sources };
  }
  return { types };
}

function materializeTraceRule(ruleSpec: ProfileTraceRule, config: ProfileConfig) {
  const rule = clone(ruleSpec);
  if (rule.if_changed !== undefined) rule.if_changed = ref(rule.if_changed, config);
  if (rule.must_touch_any !== undefined) rule.must_touch_any = ref(rule.must_touch_any, config);
  if (rule.kind === "changed_files_require_evidence" && (!Array.isArray(rule.must_touch_any) || rule.must_touch_any.length === 0)) return null;
  if (rule.kind === "declared_anchors_require_evidence" && (!Array.isArray(rule.must_touch_any) || rule.must_touch_any.length === 0)) return null;
  return rule;
}

export function compileProfilePolicy(policy: unknown): ProfileCompileResult {
  const profile = (policy as PolicyProjection | null | undefined)?.profile as string | undefined;
  if (!profile) return { ok: true, profile: null, config: null };
  const spec = (PACKS as unknown as Record<string, ProfileSpec>)[profile];
  if (!spec) return { ok: false, error: `unknown policy profile "${profile}"` };
  try {
    const config = configFor(spec, (policy as PolicyProjection).profile_overrides || {});
    return { ok: true, profile, config, spec };
  } catch (error: unknown) {
    return { ok: false, error: (error as Error).message };
  }
}

export function expandPolicyProfile(policy: unknown) {
  const compiled = compileProfilePolicy(policy);
  if (!compiled.ok || !compiled.profile) return compiled.ok ? { ok: true, policy: clone(policy) } : compiled;
  const base = clone(policy) as PolicyProjection;
  const { spec, config } = compiled;
  if (base.anchors === undefined) base.anchors = materializeAnchor(spec, config);
  if (base.trace_rules === undefined) base.trace_rules = spec.trace_rules.map((rule) => materializeTraceRule(rule, config)).filter(Boolean);
  return { ok: true, policy: base };
}

export function resolvePolicyProfile(policy: unknown) {
  return expandPolicyProfile(policy);
}

export function listBuiltInProfiles(): string[] {
  return Object.keys(PACKS).sort();
}
