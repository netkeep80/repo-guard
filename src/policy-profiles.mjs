const REQUIREMENT_ID = "(?:BR|SR|FR|NFR|CR|IR)-[0-9]{3}";

const PACKS = {
  "requirements-strict": {
    defaults: {
      requirement_json_globs: [
        "requirements/business/*.json", "requirements/stakeholder/*.json", "requirements/functional/*.json",
        "requirements/nonfunctional/*.json", "requirements/constraints/*.json", "requirements/interface/*.json",
      ],
      code_reference_globs: [
        "scripts/**/*.js", "include/**/*.{h,hpp,hh}", "src/**/*.{h,hpp,hh,c,cc,cpp,cxx}",
        "tests/**/*.{h,hpp,hh,c,cc,cpp,cxx,js,mjs}", "examples/**/*.{h,hpp,hh,c,cc,cpp,cxx,js,mjs}",
      ],
      doc_reference_globs: ["*.md", "docs/**/*.md", "requirements/**/*.md", ".github/**/*.md"],
      strict_heading_docs: ["docs/**/*.md"],
      evidence_surfaces: ["src/**", "tests/**", "docs/**", "README.md", "requirements/README.md"],
      implementation_evidence_surfaces: ["include/**", "src/**", "scripts/**", ".github/workflows/**"],
      verification_evidence_surfaces: ["tests/**", "experiments/**", "scripts/**", ".github/workflows/**"],
    },
    anchors: {
      requirement_id: { kind: "json_field", globs: "$requirement_json_globs", field: "id" },
      requirement_json_req_ref: { kind: "regex", globs: "$requirement_json_globs", pattern: `"(${REQUIREMENT_ID})"` },
      code_req_ref: { kind: "regex", globs: "$code_reference_globs", pattern: `(?:@req\\s+|,\\s*)(${REQUIREMENT_ID})` },
      doc_req_ref: { kind: "regex", globs: "$doc_reference_globs", pattern: `(?:^|[^A-Z0-9])(${REQUIREMENT_ID})(?![0-9])` },
      doc_heading_req_ref: { kind: "regex", globs: "$strict_heading_docs", pattern: `(?:^|\\n)#{1,6}\\s+[^\\n]*?\\[(${REQUIREMENT_ID})\\]` },
      doc_heading_without_req_ref: { kind: "regex", globs: "$strict_heading_docs", pattern: `(?:^|\\n)(#{1,6}\\s+(?![^\\n]*\\[${REQUIREMENT_ID}\\])[^\\n]*)` },
    },
    trace_rules: [
      { id: "requirement-json-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "requirement_json_req_ref", to_anchor_type: "requirement_id" },
      { id: "code-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "code_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "doc_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-heading-req-refs-must-resolve", kind: "must_resolve", from_anchor_type: "doc_heading_req_ref", to_anchor_type: "requirement_id" },
      { id: "doc-headings-must-have-req-ref", kind: "must_resolve", from_anchor_type: "doc_heading_without_req_ref", to_anchor_type: "requirement_id" },
      { id: "changed-requirements-need-evidence", kind: "changed_files_require_evidence", if_changed: "$requirement_json_globs", must_touch_any: "$changed_requirement_evidence_surfaces" },
      { id: "declared-affected-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.affects", must_touch_any: "$affected_evidence_surfaces" },
      { id: "declared-implemented-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.implements", must_touch_any: "$implementation_evidence_surfaces" },
      { id: "declared-verified-anchors-need-evidence", kind: "declared_anchors_require_evidence", change_intent_field: "anchors.verifies", must_touch_any: "$verification_evidence_surfaces" },
    ],
  },
};

const OVERRIDE_FIELDS = new Set([
  ...Object.keys(PACKS["requirements-strict"].defaults),
  "changed_requirement_evidence_surfaces", "affected_evidence_surfaces",
]);
const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ref = (value, config) => typeof value === "string" && value.startsWith("$") ? clone(config[value.slice(1)]) : clone(value);

function configFor(spec, overrides = {}) {
  const config = clone(spec.defaults);
  for (const [key, value] of Object.entries(overrides)) config[key] = clone(value);
  config.changed_requirement_evidence_surfaces ||= clone(config.evidence_surfaces);
  config.affected_evidence_surfaces ||= clone(config.evidence_surfaces);
  return config;
}

function materializePack(spec, overrides) {
  const config = configFor(spec, overrides), types = {};
  for (const [name, source] of Object.entries(spec.anchors)) {
    const globs = ref(source.globs, config);
    types[name] = { sources: globs.map((glob) => source.kind === "json_field"
      ? { kind: source.kind, glob, field: source.field }
      : { kind: source.kind, glob, pattern: source.pattern }) };
  }
  const trace_rules = spec.trace_rules.map((rule) => Object.fromEntries(
    Object.entries(rule).map(([key, value]) => [key, ref(value, config)])
  ));
  return { anchors: { types }, trace_rules };
}

export const listBuiltInProfiles = () => Object.keys(PACKS).sort();

export function compileProfilePolicy(policy) {
  const errors = [], profile = policy?.profile, overrides = policy?.profile_overrides;
  if (overrides !== undefined && !profile) errors.push({ field: "profile_overrides", message: "profile_overrides requires top-level profile" });
  if (profile !== undefined && !PACKS[profile]) errors.push({ field: "profile", profile, message: `profile "${profile}" is not supported; use ${listBuiltInProfiles().join(", ")}` });
  if (overrides !== undefined) {
    if (!isObject(overrides)) errors.push({ field: "profile_overrides", message: "profile_overrides must be an object" });
    else for (const [field, value] of Object.entries(overrides)) {
      if (!OVERRIDE_FIELDS.has(field)) errors.push({ field: `profile_overrides.${field}`, message: `profile_overrides.${field} is not supported` });
      else if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
        errors.push({ field: `profile_overrides.${field}`, message: `profile_overrides.${field} must be a non-empty array of non-empty strings` });
      }
    }
  }
  return errors;
}

export function expandPolicyProfile(policy) {
  const base = clone(policy), spec = PACKS[base.profile];
  if (!spec) return base;
  const patch = materializePack(spec, base.profile_overrides || {});
  return { ...base, anchors: base.anchors || patch.anchors, trace_rules: base.trace_rules || patch.trace_rules };
}

export function resolvePolicyProfile(policy) {
  const errors = compileProfilePolicy(policy);
  return { ok: !errors.length, policy: errors.length ? clone(policy) : expandPolicyProfile(policy), errors };
}
