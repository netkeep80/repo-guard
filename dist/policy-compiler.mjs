const list = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function compileForbidRegex(contentRules = []) {
  const errors = [];
  for (const rule of list(contentRules)) for (const pattern of list(rule?.forbid_regex)) {
    try { new RegExp(pattern); }
    catch (error) { errors.push({ rule_id: rule?.id, pattern, message: error.message }); }
  }
  return errors;
}

export function compileChangeProfiles(policy = {}) {
  const errors = [], profiles = object(policy.change_profiles);
  const surfaces = new Set(Object.keys(object(policy.surfaces)));
  const classes = new Set(Object.keys(object(policy.new_file_classes)));
  for (const [changeType, profile] of Object.entries(profiles)) {
    const p = object(profile), allowed = new Set(list(p.allow_surfaces));
    for (const field of ["allow_surfaces", "forbid_surfaces", "require_surfaces"]) for (const surface of list(p[field])) {
      if (!surfaces.has(surface)) errors.push({ change_type: changeType, surface, message: `change_profiles["${changeType}"].${field} references unknown surface "${surface}"` });
    }
    for (const surface of list(p.forbid_surfaces)) if (allowed.has(surface)) errors.push({ change_type: changeType, surface, message: `change_profiles["${changeType}"] lists surface "${surface}" in both allow_surfaces and forbid_surfaces` });
    const newFiles = object(p.new_files);
    for (const fileClass of [...list(newFiles.allow_classes), ...Object.keys(object(newFiles.max_per_class))]) if (!classes.has(fileClass)) {
      errors.push({ change_type: changeType, class: fileClass, message: `change_profiles["${changeType}"].new_files references unknown class "${fileClass}"` });
    }
  }
  return errors;
}

export function compileAnchorPolicy(policy = {}) {
  const errors = [], types = object(policy.anchors?.types), typeNames = new Set(Object.keys(types)), ids = new Set();
  for (const [anchorType, config] of Object.entries(types)) for (const [sourceIndex, source] of list(config?.sources).entries()) {
    if (source?.kind !== "regex") continue;
    try { new RegExp(source.pattern); }
    catch (error) { errors.push({ anchor_type: anchorType, source_index: sourceIndex, pattern: source.pattern, message: `anchors.types["${anchorType}"].sources[${sourceIndex}].pattern is invalid: ${error.message}` }); }
  }
  for (const [index, rule] of list(policy.trace_rules).entries()) {
    if (ids.has(rule?.id)) errors.push({ trace_rule: rule?.id, message: `trace_rules[${index}].id duplicates trace rule "${rule?.id}"` });
    ids.add(rule?.id);
    if (rule?.kind === "must_resolve") for (const field of ["from_anchor_type", "to_anchor_type"]) {
      if (!typeNames.has(rule[field])) errors.push({ trace_rule: rule.id, anchor_type: rule[field], message: `trace_rules[${index}].${field} references unknown anchor type "${rule[field]}"` });
    }
    if (rule?.kind === "declared_anchors_require_evidence" && !["anchors.affects", "anchors.implements", "anchors.verifies"].includes(rule.change_intent_field)) {
      errors.push({ trace_rule: rule.id, change_intent_field: rule.change_intent_field, message: `trace_rules[${index}].change_intent_field references unsupported ChangeIntent anchor field` });
    }
  }
  return errors;
}

function semanticIntegrationEntries(integration) {
  return ["workflows", "templates", "docs", "profiles"].flatMap((section) => list(integration?.[section]).map((entry, index) => ({ section, index, entry: object(entry) })));
}
export function compileIntegrationPolicy(policy = {}) {
  const integration = object(policy.integration);
  if (!policy.integration || !Object.keys(integration).length) return [];
  const errors = [], seen = new Map(), profileIds = new Set(), references = [];
  for (const { section, index, entry } of semanticIntegrationEntries(integration)) {
    const id = entry.id;
    if (typeof id === "string" && id) {
      if (seen.has(id)) {
        const previous = seen.get(id);
        errors.push({ section, id, index, previous_section: previous.section, previous_index: previous.index, message: `integration.${section}[${index}].id duplicates integration.${previous.section}[${previous.index}].id "${id}"` });
      } else seen.set(id, { section, index });
      if (section === "profiles") profileIds.add(id);
    }
    for (const profileId of list(entry.profiles)) references.push({ section, index, field: "profiles", profileId });
    if (section === "docs") for (const profileId of list(entry.must_mention_profiles)) references.push({ section, index, field: "must_mention_profiles", profileId });
  }
  for (const ref of references) if (!profileIds.has(ref.profileId)) errors.push({ section: ref.section, index: ref.index, field: ref.field, profile_id: ref.profileId, message: `integration.${ref.section}[${ref.index}].${ref.field} references unknown integration.profiles id "${ref.profileId}"` });
  return errors;
}

export function warnReservedPolicyFields(policy = {}) {
  return list(policy.paths?.public_api).length ? ["paths.public_api: defined but reserved for future use; not enforced at runtime"] : [];
}
