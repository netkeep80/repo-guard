import { normalizeDocumentFact } from "../document-facts.mjs";
const sha = /^[0-9a-f]{40}$/;
const strongRequirementRelations = new Set(["derives_from", "depends_on", "constrains", "supersedes"]);
const protectedLifecycleFields = new Set(["accepted", "current", "published"]);
const allDeltaKinds = new Set([
    "requirement_add", "requirement_modify", "requirement_remove", "requirement_relocate",
    "relation_add", "relation_remove", "relation_replace",
    "constraint_add", "constraint_modify", "constraint_remove",
    "resource_add", "resource_modify", "resource_delete", "resource_rename", "resource_type_change", "lifecycle",
]);
const obj = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const normPath = (value) => {
    if (typeof value !== "string")
        throw new Error("path must be a string");
    const normalized = normalizeDocumentFact(value, "repository_path");
    if (normalized !== value || /[*?\[\]{}]/.test(value) || value.endsWith("/"))
        throw new Error("noncanonical or wildcard path");
    return value;
};
function stable(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return "[" + value.map(stable).join(",") + "]";
    const record = obj(value);
    if (record)
        return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stable(record[key])).join(",") + "}";
    throw new Error("non-canonical transition value");
}
const sorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
const exactRevision = (value) => typeof value === "string" && sha.test(value);
const permissionToken = (value) => typeof value === "string" && value.length > 0 && value !== "*";
function requirementCore(value) {
    const root = obj(value);
    if (!root)
        return stable(value);
    return stable(Object.fromEntries(Object.entries(root).filter(([key]) => key !== "relations" && key !== "constraints")));
}
function targetIdentity(value) {
    const target = obj(value);
    if (!target || typeof target.kind !== "string")
        throw new Error("relation target must be a typed object");
    if (target.kind === "requirement") {
        if (typeof target.id !== "string" || !target.id)
            throw new Error("requirement relation target requires id");
        return { key: stable({ kind: "requirement", id: target.id }), requirement: target.id };
    }
    if (target.kind === "artifact") {
        const path = normPath(target.path);
        return { key: stable({ kind: "artifact", path }), path };
    }
    return { key: stable(target) };
}
function relationFactKey(fact) {
    return stable({ origin: fact.origin, from: fact.from, predicate: fact.predicate, target: fact.targetKey });
}
function relations(state) {
    const facts = [], errors = [];
    for (const id of Object.keys(state.requirements.index).sort((a, b) => a.localeCompare(b, "en"))) {
        const root = obj(state.requirements.index[id]?.value);
        const relationMap = obj(root?.relations);
        if (root?.relations !== undefined && !relationMap) {
            errors.push("invalid_relation_map:" + id);
            continue;
        }
        for (const label of Object.keys(relationMap || {}).sort((a, b) => a.localeCompare(b, "en"))) {
            const item = obj(relationMap[label]);
            if (!item || typeof item.predicate !== "string" || item.predicate.length === 0) {
                errors.push(`invalid_relation:${id}:${label}`);
                continue;
            }
            try {
                const target = targetIdentity(item.target);
                const factBase = { origin: "requirement", from: id, predicate: item.predicate, targetKey: target.key,
                    ...(target.requirement ? { targetRequirement: target.requirement } : {}), ...(target.path ? { targetPath: target.path } : {}) };
                facts.push({ ...factBase, key: relationFactKey(factBase) });
            }
            catch (error) {
                errors.push(`invalid_relation:${id}:${label}:${error.message}`);
            }
        }
    }
    for (const [index, edge] of (state.resourceRelations || []).entries()) {
        if (edge.kind !== "generates") {
            errors.push(`invalid_resource_relation:${index}:unsupported_kind`);
            continue;
        }
        try {
            const from = normPath(edge.from), to = normPath(edge.to);
            const factBase = { origin: "resource", from, predicate: "generates", targetKey: stable({ kind: "artifact", path: to }), targetPath: to };
            facts.push({ ...factBase, key: relationFactKey(factBase) });
        }
        catch (error) {
            errors.push(`invalid_resource_relation:${index}:${error.message}`);
        }
    }
    const dedup = new Map();
    for (const fact of facts) {
        if (dedup.has(fact.key))
            errors.push("duplicate_relation:" + fact.key);
        else
            dedup.set(fact.key, fact);
    }
    return { facts: [...dedup.values()].sort((a, b) => a.key.localeCompare(b.key, "en")), errors: sorted(errors) };
}
function relationDeltas(base, head) {
    const before = new Map(base.map(x => [x.key, x])), after = new Map(head.map(x => [x.key, x]));
    const removed = base.filter(x => !after.has(x.key)), added = head.filter(x => !before.has(x.key));
    const byGroup = (items) => {
        const map = new Map();
        for (const item of items) {
            const key = stable({ origin: item.origin, from: item.from, predicate: item.predicate });
            const values = map.get(key) || [];
            values.push(item);
            map.set(key, values);
        }
        for (const values of map.values())
            values.sort((a, b) => a.key.localeCompare(b.key, "en"));
        return map;
    };
    const rGroups = byGroup(removed), aGroups = byGroup(added), usedR = new Set(), usedA = new Set(), out = [];
    for (const group of sorted(new Set([...rGroups.keys(), ...aGroups.keys()]))) {
        const rs = rGroups.get(group) || [], as = aGroups.get(group) || [];
        if (rs.length === 1 && as.length === 1) {
            const r = rs[0], a = as[0];
            usedR.add(r.key);
            usedA.add(a.key);
            out.push({ id: "relation_replace:" + r.key + "->" + a.key, kind: "relation_replace", subject: r.from, beforeRelation: r, afterRelation: a, relation: a });
        }
    }
    for (const fact of removed.filter(x => !usedR.has(x.key)))
        out.push({ id: "relation_remove:" + fact.key, kind: "relation_remove", subject: fact.from, relation: fact });
    for (const fact of added.filter(x => !usedA.has(x.key)))
        out.push({ id: "relation_add:" + fact.key, kind: "relation_add", subject: fact.from, relation: fact });
    return out.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
function requirementDeltas(base, head) {
    const out = [];
    const ids = sorted(new Set([...Object.keys(base.requirements.index), ...Object.keys(head.requirements.index)]));
    for (const id of ids) {
        const before = base.requirements.index[id], after = head.requirements.index[id];
        if (!before)
            out.push({ id: "requirement_add:" + id, kind: "requirement_add", subject: id, requirementId: id });
        else if (!after)
            out.push({ id: "requirement_remove:" + id, kind: "requirement_remove", subject: id, requirementId: id });
        else {
            if (requirementCore(before.value) !== requirementCore(after.value))
                out.push({ id: "requirement_modify:" + id, kind: "requirement_modify", subject: id, requirementId: id });
            if (before.source.path !== after.source.path)
                out.push({ id: `requirement_relocate:${id}:${before.source.path}->${after.source.path}`, kind: "requirement_relocate", subject: id, requirementId: id, beforePath: before.source.path, afterPath: after.source.path });
        }
    }
    return out;
}
function constraintDeltas(base, head) {
    const out = [];
    const ids = sorted(new Set([...Object.keys(base.requirements.index), ...Object.keys(head.requirements.index)]));
    const indexed = (value) => {
        const raw = obj(value)?.constraints;
        const result = new Map();
        if (!Array.isArray(raw))
            return result;
        for (const item of raw) {
            const record = obj(item);
            if (record && typeof record.id === "string" && !result.has(record.id))
                result.set(record.id, item);
        }
        return result;
    };
    for (const requirementId of ids) {
        const beforeRequirement = base.requirements.index[requirementId];
        const afterRequirement = head.requirements.index[requirementId];
        if (!beforeRequirement || !afterRequirement)
            continue;
        const before = indexed(beforeRequirement.value), after = indexed(afterRequirement.value);
        for (const constraintId of sorted(new Set([...before.keys(), ...after.keys()]))) {
            const b = before.get(constraintId), a = after.get(constraintId);
            if (b === undefined)
                out.push({
                    id: "constraint_add:" + requirementId + ":" + constraintId,
                    kind: "constraint_add", subject: requirementId, requirementId, constraintId,
                });
            else if (a === undefined)
                out.push({
                    id: "constraint_remove:" + requirementId + ":" + constraintId,
                    kind: "constraint_remove", subject: requirementId, requirementId, constraintId,
                });
            else if (stable(b) !== stable(a))
                out.push({
                    id: "constraint_modify:" + requirementId + ":" + constraintId,
                    kind: "constraint_modify", subject: requirementId, requirementId, constraintId,
                });
        }
    }
    return out;
}
function resourceDeltas(input) {
    const out = [], errors = [];
    for (const raw of input) {
        try {
            const path = normPath(raw.path);
            if (raw.kind === "add" || raw.kind === "modify" || raw.kind === "delete") {
                if (raw.previousPath !== undefined)
                    throw new Error("previousPath is only valid for rename");
                out.push({ id: `resource_${raw.kind}:${path}`, kind: `resource_${raw.kind}`, subject: path, afterPath: raw.kind !== "delete" ? path : undefined, beforePath: raw.kind !== "add" ? path : undefined });
            }
            else if (raw.kind === "rename") {
                const previous = normPath(raw.previousPath);
                if (previous === path)
                    throw new Error("rename requires distinct paths");
                out.push({ id: `resource_rename:${previous}->${path}`, kind: "resource_rename", subject: path, beforePath: previous, afterPath: path });
            }
            else if (raw.kind === "type_change") {
                if (raw.previousPath !== undefined && normPath(raw.previousPath) !== path)
                    throw new Error("type change previousPath must equal path");
                if (raw.beforeType !== undefined && raw.afterType !== undefined && raw.beforeType === raw.afterType)
                    throw new Error("type change requires different types");
                out.push({ id: `resource_type_change:${path}`, kind: "resource_type_change", subject: path, beforePath: path, afterPath: path });
            }
            else
                throw new Error("unsupported resource delta kind");
        }
        catch (error) {
            errors.push(`invalid_resource_delta:${String(raw.path)}:${error.message}`);
        }
    }
    const ids = new Set();
    for (const delta of out) {
        if (ids.has(delta.id))
            errors.push("duplicate_resource_delta:" + delta.id);
        ids.add(delta.id);
    }
    return { deltas: out.sort((a, b) => a.id.localeCompare(b.id, "en")), errors: sorted(errors) };
}
export function resourceDeltasFromParsedDiff(files) {
    return files.map((file) => {
        if (file.previousPath)
            return { kind: "rename", previousPath: file.previousPath, path: file.path };
        if (file.gitStatus === "T")
            return { kind: "type_change", path: file.path };
        if (file.status === "added")
            return { kind: "add", path: file.path };
        if (file.status === "deleted")
            return { kind: "delete", path: file.path };
        return { kind: "modify", path: file.path };
    });
}
function lifecycleDeltas(base, head) {
    const out = [];
    for (const subject of sorted(new Set([...Object.keys(base), ...Object.keys(head)]))) {
        const before = base[subject] || {}, after = head[subject] || {};
        for (const field of sorted(new Set([...Object.keys(before), ...Object.keys(after)]))) {
            const hasBefore = Object.hasOwn(before, field), hasAfter = Object.hasOwn(after, field);
            const b = before[field], a = after[field];
            if (hasBefore === hasAfter && (!hasBefore || stable(b) === stable(a)))
                continue;
            out.push({ id: `lifecycle:${subject}:${field}`, kind: "lifecycle", subject, field,
                ...(hasBefore ? { before: b } : {}), ...(hasAfter ? { after: a } : {}), requirementId: subject });
        }
    }
    return out;
}
function owners(state, path) {
    return path ? sorted(state.j1.owners[path] || []) : [];
}
function directCandidates(delta, base, head) {
    const result = new Set();
    if (delta.kind.startsWith("requirement_") || delta.kind.startsWith("constraint_") || delta.kind === "lifecycle") {
        if (delta.requirementId)
            result.add(delta.requirementId);
    }
    else if (delta.kind.startsWith("resource_")) {
        for (const id of owners(base, delta.beforePath))
            result.add(id);
        for (const id of owners(head, delta.afterPath))
            result.add(id);
    }
    else if (delta.kind.startsWith("relation_")) {
        const facts = [delta.beforeRelation, delta.afterRelation, delta.relation].filter(Boolean);
        for (const fact of facts) {
            if (fact.origin === "requirement")
                result.add(fact.from);
            if (fact.targetRequirement)
                result.add(fact.targetRequirement);
            if (fact.origin === "resource") {
                for (const id of owners(base, fact.from))
                    result.add(id);
                for (const id of owners(head, fact.from))
                    result.add(id);
            }
            if (fact.targetPath) {
                for (const id of owners(base, fact.targetPath))
                    result.add(id);
                for (const id of owners(head, fact.targetPath))
                    result.add(id);
            }
        }
    }
    return result;
}
function requirementImpact(seed, relationFacts, ids) {
    const impacted = new Set([...seed].filter(id => ids.has(id)));
    let changed = true;
    while (changed) {
        changed = false;
        for (const relation of relationFacts) {
            if (relation.origin !== "requirement" || !relation.targetRequirement || !ids.has(relation.from) || !ids.has(relation.targetRequirement))
                continue;
            const target = relation.targetRequirement;
            if (relation.predicate === "derives_from") {
                if (impacted.has(relation.from) && !impacted.has(target)) {
                    impacted.add(target);
                    changed = true;
                }
                if (impacted.has(target) && !impacted.has(relation.from)) {
                    impacted.add(relation.from);
                    changed = true;
                }
            }
            else if ((relation.predicate === "depends_on" || relation.predicate === "constrains") && impacted.has(target) && !impacted.has(relation.from)) {
                impacted.add(relation.from);
                changed = true;
            }
        }
    }
    return impacted;
}
function affected(delta, base, head, baseRelations, headRelations) {
    const seed = directCandidates(delta, base, head);
    const baseIds = new Set(Object.keys(base.requirements.index)), headIds = new Set(Object.keys(head.requirements.index));
    return sorted(new Set([...requirementImpact(seed, baseRelations, baseIds), ...requirementImpact(seed, headRelations, headIds)]));
}
function deltaPaths(delta) {
    const paths = [delta.beforePath, delta.afterPath, delta.relation?.targetPath, delta.beforeRelation?.targetPath, delta.afterRelation?.targetPath];
    return sorted(paths.filter((x) => typeof x === "string"));
}
function deltaPredicate(delta) {
    return delta.relation?.predicate || delta.afterRelation?.predicate || delta.beforeRelation?.predicate || null;
}
function matchesRule(rule, delta) {
    if (rule.deltaKinds && !rule.deltaKinds.includes(delta.kind))
        return false;
    const predicate = deltaPredicate(delta);
    if (rule.relationPredicates && (!predicate || !rule.relationPredicates.includes(predicate)))
        return false;
    if (rule.paths && !deltaPaths(delta).some(path => rule.paths.includes(path)))
        return false;
    return true;
}
function transitionRules(authority) {
    const rules = [], errors = [];
    const allowed = new Set(["deltaKinds", "relationPredicates", "paths", "requireAddressed", "evidenceKeys"]);
    for (const requirementId of authority.j2.rooted.slice().sort((a, b) => a.localeCompare(b, "en"))) {
        const requirement = authority.requirements.index[requirementId];
        const raw = obj(obj(requirement?.value)?.transition);
        if (obj(requirement?.value)?.transition === undefined)
            continue;
        if (!raw) {
            errors.push("invalid_transition_rule:" + requirementId + ":not_object");
            continue;
        }
        const unknown = Object.keys(raw).filter(key => !allowed.has(key)).sort();
        if (unknown.length) {
            errors.push("invalid_transition_rule:" + requirementId + ":unknown_field:" + unknown[0]);
            continue;
        }
        const arrayOfStrings = (value) => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
        if (raw.deltaKinds !== undefined && (!arrayOfStrings(raw.deltaKinds) || raw.deltaKinds.some(kind => !allDeltaKinds.has(kind)))) {
            errors.push("invalid_transition_rule:" + requirementId + ":deltaKinds");
            continue;
        }
        if (raw.relationPredicates !== undefined && !arrayOfStrings(raw.relationPredicates)) {
            errors.push("invalid_transition_rule:" + requirementId + ":relationPredicates");
            continue;
        }
        if (raw.paths !== undefined && !arrayOfStrings(raw.paths)) {
            errors.push("invalid_transition_rule:" + requirementId + ":paths");
            continue;
        }
        if (raw.requireAddressed !== undefined && typeof raw.requireAddressed !== "boolean") {
            errors.push("invalid_transition_rule:" + requirementId + ":requireAddressed");
            continue;
        }
        if (raw.evidenceKeys !== undefined && !arrayOfStrings(raw.evidenceKeys)) {
            errors.push("invalid_transition_rule:" + requirementId + ":evidenceKeys");
            continue;
        }
        if (raw.deltaKinds === undefined && raw.relationPredicates === undefined && raw.paths === undefined) {
            errors.push("invalid_transition_rule:" + requirementId + ":unscoped");
            continue;
        }
        try {
            for (const path of raw.paths || [])
                normPath(path);
        }
        catch {
            errors.push("invalid_transition_rule:" + requirementId + ":path");
            continue;
        }
        rules.push({ authorityRevision: authority.revision, requirementId,
            ...(raw.deltaKinds !== undefined ? { deltaKinds: [...raw.deltaKinds] } : {}),
            ...(raw.relationPredicates !== undefined ? { relationPredicates: [...raw.relationPredicates] } : {}),
            ...(raw.paths !== undefined ? { paths: [...raw.paths] } : {}),
            ...(raw.requireAddressed !== undefined ? { requireAddressed: raw.requireAddressed } : {}),
            ...(raw.evidenceKeys !== undefined ? { evidenceKeys: [...raw.evidenceKeys] } : {}),
        });
    }
    return { rules: rules.sort((a, b) => a.requirementId.localeCompare(b.requirementId, "en")), errors: sorted(errors) };
}
function workIntentAddresses(value) {
    if (value === null || value === undefined)
        return { addresses: [], errors: [] };
    if (!Array.isArray(value.addresses) || value.addresses.some(id => typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(id)))
        return { addresses: [], errors: ["invalid_work_intent_addresses"] };
    return { addresses: sorted(value.addresses), errors: [] };
}
function validReceipts(input) {
    const receipts = [], errors = [];
    for (const item of input.trustedReceipts || []) {
        if (!exactRevision(item.authorityBaseRevision) || !exactRevision(item.baseRevision) || !exactRevision(item.headRevision) ||
            !Array.isArray(item.permissions) || item.permissions.some(x => !permissionToken(x))) {
            errors.push("invalid_trusted_receipt");
            continue;
        }
        receipts.push(item);
    }
    return { receipts, errors: sorted(errors) };
}
function granted(input, receipts, permission) {
    return receipts.some(receipt => receipt.authorityBaseRevision === input.trustedAuthorityBase.revision && receipt.baseRevision === input.base.revision &&
        receipt.headRevision === input.head.revision && receipt.permissions.includes(permission));
}
function validEvidence(input) {
    const facts = [], errors = [];
    for (const item of input.evidenceFacts || []) {
        if (!exactRevision(item.authorityBaseRevision) || !exactRevision(item.baseRevision) || !exactRevision(item.headRevision) ||
            typeof item.key !== "string" || !item.key || !['pass', 'fail'].includes(item.status)) {
            errors.push("invalid_evidence_fact");
            continue;
        }
        facts.push(item);
    }
    return { facts, errors: sorted(errors) };
}
function evidencePass(input, facts, key) {
    return facts.some(fact => fact.authorityBaseRevision === input.trustedAuthorityBase.revision && fact.baseRevision === input.base.revision &&
        fact.headRevision === input.head.revision && fact.key === key && fact.status === "pass");
}
function providerSubjectPaths(value) {
    if (!Array.isArray(value) || value.some(path => typeof path !== "string"))
        return null;
    try {
        const paths = value.map(path => normPath(path));
        if (new Set(paths).size !== paths.length)
            return null;
        return sorted(paths);
    }
    catch {
        return null;
    }
}
function validProviderGrants(input) {
    const grants = [], errors = [];
    for (const raw of input.authenticatedProviderGrants || []) {
        const item = obj(raw), capability = obj(item?.capability);
        const common = !!item && !!capability &&
            typeof item.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository) &&
            exactRevision(item.authorityBaseRevision) && exactRevision(item.baseRevision) && exactRevision(item.headRevision) &&
            typeof item.providerId === "string" && item.providerId.length > 0 && item.providerId !== "*" &&
            typeof item.principal === "string" && item.principal.length > 0 && item.principal !== "*" &&
            typeof item.producerSource === "string" && item.producerSource.length > 0 && item.producerSource !== "*" &&
            (item.boundary === "observation" || item.boundary === "domain");
        if (!common) {
            errors.push("invalid_provider_grant");
            continue;
        }
        const subjects = providerSubjectPaths(capability.subjectPaths);
        if (!subjects || typeof capability.key !== "string" || !capability.key || capability.key === "*") {
            errors.push("invalid_provider_grant");
            continue;
        }
        if (capability.kind === "metric") {
            if (item.boundary !== "observation" || Object.keys(capability).some(k => !["kind", "key", "subjectPaths"].includes(k))) {
                errors.push("invalid_provider_grant");
                continue;
            }
        }
        else if (capability.kind === "evidence") {
            if (item.boundary !== "domain" || (capability.class !== "execution" && capability.class !== "domain") ||
                typeof capability.requirementId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(capability.requirementId) ||
                Object.keys(capability).some(k => !["kind", "class", "key", "requirementId", "subjectPaths", "verifierPath", "verifierRevision"].includes(k))) {
                errors.push("invalid_provider_grant");
                continue;
            }
            const hasVerifier = capability.verifierPath !== undefined || capability.verifierRevision !== undefined;
            if (capability.class === "execution" && !hasVerifier) {
                errors.push("invalid_provider_grant");
                continue;
            }
            if (hasVerifier) {
                if (typeof capability.verifierPath !== "string" || !exactRevision(capability.verifierRevision)) {
                    errors.push("invalid_provider_grant");
                    continue;
                }
                try {
                    normPath(capability.verifierPath);
                }
                catch {
                    errors.push("invalid_provider_grant");
                    continue;
                }
            }
        }
        else {
            errors.push("invalid_provider_grant");
            continue;
        }
        grants.push(raw);
    }
    const identities = new Map(), conflicted = new Set();
    for (const grant of grants) {
        const identity = grant.principal + "\0" + grant.producerSource;
        const prior = identities.get(grant.providerId);
        if (prior !== undefined && prior !== identity)
            conflicted.add(grant.providerId);
        else
            identities.set(grant.providerId, identity);
    }
    if (conflicted.size)
        errors.push("invalid_provider_grant");
    return { grants: grants.filter(grant => !conflicted.has(grant.providerId)), errors: sorted(errors) };
}
const grantTransitionMatches = (input, grant) => grant.repository === input.repository &&
    grant.authorityBaseRevision === input.trustedAuthorityBase.revision &&
    grant.baseRevision === input.base.revision &&
    grant.headRevision === input.head.revision;
const metricAuthorityKey = (metric) => metric === "changed_lines" ? "git.changed_lines" : metric;
function observationProviderAuthorized(input, grants, fact, path) {
    return grants.some(grant => {
        if (!grantTransitionMatches(input, grant) || grant.providerId !== fact.providerId || grant.boundary !== "observation" || grant.capability.kind !== "metric")
            return false;
        return grant.capability.key === metricAuthorityKey(fact.metric) &&
            stable(providerSubjectPaths(grant.capability.subjectPaths) || []) === stable([path]);
    });
}
function evidenceProviderAuthorized(input, grants, fact, spec, requirementId, touched) {
    if (typeof fact.providerId !== "string" || !fact.providerId)
        return false;
    return grants.some(grant => {
        if (!grantTransitionMatches(input, grant) || grant.providerId !== fact.providerId || grant.boundary !== "domain" || grant.capability.kind !== "evidence")
            return false;
        const capability = grant.capability;
        if (capability.class !== spec.kind || capability.key !== spec.key || capability.requirementId !== requirementId)
            return false;
        if (stable(providerSubjectPaths(capability.subjectPaths) || []) !== stable(touched))
            return false;
        if (capability.class === "execution")
            return capability.verifierPath === spec.verifierPath && capability.verifierRevision === input.head.revision;
        if (capability.verifierPath !== undefined || capability.verifierRevision !== undefined)
            return capability.verifierPath === fact.verifierPath && capability.verifierRevision === fact.verifierRevision;
        return true;
    });
}
function authorityPermissions(delta, input, protectedSet) {
    const result = new Set();
    if (delta.kind === "requirement_add" || delta.kind === "requirement_modify" || delta.kind === "requirement_remove")
        result.add("requirement:" + delta.subject);
    if (delta.kind.startsWith("constraint_") && delta.requirementId && delta.constraintId)
        result.add("constraint_definition:" + delta.requirementId + ":" + delta.constraintId);
    if (delta.kind.startsWith("relation_")) {
        const facts = [delta.beforeRelation, delta.afterRelation, delta.relation].filter(Boolean);
        // Each actual relation transition is evaluated against BOTH exact states.
        // A strong BASE obligation cannot disappear merely because HEAD supplies a weak trace.
        // Descriptive changes remain subject to J1/J2/J3, never to a blanket removal grant.
        for (const fact of facts) {
            if (fact.origin === "requirement" && (fact.predicate === "requires" || strongRequirementRelations.has(fact.predicate)))
                result.add("requirement:" + fact.from);
            if (fact.origin === "resource" && fact.predicate === "generates" &&
                (delta.kind === "relation_remove" || delta.kind === "relation_replace"))
                result.add("resource:" + fact.from);
        }
    }
    if (delta.kind === "lifecycle" && delta.field && protectedLifecycleFields.has(delta.field) && (delta.before === true || delta.after === true))
        result.add(`lifecycle:${delta.subject}:${delta.field}`);
    for (const path of deltaPaths(delta))
        if (protectedSet.has(path) && delta.kind.startsWith("resource_"))
            result.add("resource:" + path);
    return sorted(result);
}
function snapshotErrors(label, state, repository) {
    const errors = [];
    if (!exactRevision(state.revision))
        errors.push(`${label}:invalid_revision`);
    if (!state.requirements.ok)
        errors.push(`${label}:invalid_requirements`);
    for (const req of state.requirements.requirements)
        if (req.representation.repository !== repository || req.representation.revision !== state.revision) {
            errors.push(`${label}:snapshot_mismatch`);
            break;
        }
    if (!state.j2.ok)
        errors.push(`${label}:j2_not_rooted`);
    return errors;
}
function evaluateScopedObligations(input, deltas, receipts, facts, applicability) {
    const problems = [], explanations = [];
    const root = (state, id) => obj(state.requirements.index[id]?.value);
    const parseRules = (state, label, id) => {
        const raw = root(state, id)?.constraints;
        if (raw === undefined)
            return [];
        if (!Array.isArray(raw)) {
            problems.push("I7:invalid_constraints:" + label + ":" + id);
            return [];
        }
        const seen = new Set(), rules = [];
        for (const item of raw) {
            const rule = obj(item), evidence = obj(rule?.evidence);
            if (!rule || typeof rule.id !== "string" || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(rule.id) ||
                seen.has(rule.id) || !Array.isArray(rule.relations) || !rule.relations.length ||
                rule.relations.some((p) => !["requires", "implemented_by", "verified_by", "documents", "generates", "constrains"].includes(String(p))) ||
                (rule.activation !== undefined && !["scoped_change", "requirement_cause"].includes(String(rule.activation))) ||
                (rule.includeGenerated !== undefined && typeof rule.includeGenerated !== "boolean") ||
                (rule.metric !== undefined && !["changed_lines", "changed_resources"].includes(String(rule.metric))) ||
                (rule.metric === undefined && rule.max !== undefined) ||
                (rule.metric !== undefined && (typeof rule.max !== "number" || !Number.isSafeInteger(rule.max) || rule.max < 0)) ||
                (rule.metric === undefined && rule.evidence === undefined) ||
                (rule.evidence !== undefined && (!evidence || !["execution", "domain"].includes(String(evidence.kind)) ||
                    typeof evidence.key !== "string" || !evidence.key ||
                    (evidence.providerId !== undefined && (typeof evidence.providerId !== "string" || !evidence.providerId)) ||
                    (evidence.kind === "execution" && typeof evidence.verifierPath !== "string"))) ||
                Object.keys(rule).some(k => !["id", "activation", "relations", "includeGenerated", "metric", "max", "evidence"].includes(k))) {
                problems.push("I7:invalid_constraint:" + label + ":" + id);
                continue;
            }
            seen.add(rule.id);
            rules.push(rule);
        }
        return rules;
    };
    const derive = (state, id, rule, fallbackEdges) => {
        const paths = new Map();
        const direct = obj(root(state, id)?.relations);
        const put = (path, proof) => {
            const old = paths.get(path);
            if (!old || proof.length < old.length || (proof.length === old.length && proof.join("\0") < old.join("\0")))
                paths.set(path, proof);
        };
        for (const name of Object.keys(direct || {}).sort()) {
            const rel = obj(direct[name]), target = obj(rel?.target);
            if (!rel || !target || target.kind !== "artifact" || !rule.relations.includes(rel.predicate))
                continue;
            try {
                const path = normPath(target.path);
                put(path, [id, String(rel.predicate) + ":" + path]);
            }
            catch {
                problems.push("I7:invalid_scope:" + id + ":" + name);
            }
        }
        if (rule.includeGenerated === true) {
            const edges = (state.resourceRelations || fallbackEdges)
                .slice().sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
            let change = true;
            while (change) {
                change = false;
                for (const edge of edges) {
                    if (edge.kind !== "generates" || !paths.has(edge.from))
                        continue;
                    try {
                        const to = normPath(edge.to), from = normPath(edge.from);
                        const prior = paths.get(to);
                        put(to, [...paths.get(from), "generates:" + to]);
                        if (prior !== paths.get(to))
                            change = true;
                    }
                    catch {
                        problems.push("I7:invalid_generation_scope:" + id);
                    }
                }
            }
        }
        return paths;
    };
    const versions = [
        { label: "AUTHORITY", state: input.trustedAuthorityBase },
        { label: "BASE", state: input.base },
        { label: "HEAD", state: input.head },
    ];
    const ids = sorted(new Set(versions.flatMap(v => Object.keys(v.state.requirements.index))));
    const providers = new Set(input.trustedEvidenceProviders || []);
    const providerState = validProviderGrants(input);
    problems.push(...providerState.errors.map(error => "I7:" + error));
    const capabilityMode = input.authenticatedProviderGrants !== undefined;
    const observation = input.observationFacts || [];
    const observationMap = new Map();
    for (const o of observation) {
        if (!o || typeof o !== "object") {
            problems.push("I7:invalid_observation_fact");
            continue;
        }
        try {
            const path = normPath(o.path);
            if (!exactRevision(o.authorityBaseRevision) || !exactRevision(o.baseRevision) || !exactRevision(o.headRevision) ||
                o.authorityBaseRevision !== input.trustedAuthorityBase.revision || o.baseRevision !== input.base.revision ||
                o.headRevision !== input.head.revision || o.metric !== "changed_lines" ||
                typeof o.providerId !== "string" || !o.providerId ||
                !Number.isSafeInteger(o.value) || o.value < 0) {
                problems.push("I7:invalid_observation:" + path);
                continue;
            }
            const providerAuthorized = capabilityMode
                ? observationProviderAuthorized(input, providerState.grants, o, path)
                : providers.has(o.providerId);
            if (!providerAuthorized) {
                problems.push(capabilityMode
                    ? "I7:unauthorized_observation_provider:" + path + ":" + o.metric
                    : "I7:invalid_observation:" + path);
                continue;
            }
            const key = o.metric + "\0" + path;
            if (observationMap.has(key))
                problems.push("I7:duplicate_observation:" + path);
            else
                observationMap.set(key, o.value);
        }
        catch {
            problems.push("I7:invalid_observation_path");
        }
    }
    for (const id of ids) {
        const applied = new Set();
        for (const v of versions) {
            if (!v.state.j2.rooted.includes(id))
                continue;
            for (const rule of parseRules(v.state, v.label, id)) {
                const fingerprint = stable(rule);
                if (applied.has(fingerprint))
                    continue;
                applied.add(fingerprint);
                if (v.label === "AUTHORITY" && rule.includeGenerated === true &&
                    input.trustedAuthorityBase.revision !== input.base.revision && input.trustedAuthorityBase.resourceRelations === undefined)
                    problems.push("I7:missing_trusted_generation_scope:" + id + ":" + rule.id);
                const trustedEdges = input.trustedAuthorityBase.resourceRelations ||
                    (input.trustedAuthorityBase.revision === input.base.revision ? input.base.resourceRelations || [] : []);
                const allScopes = [
                    derive(input.trustedAuthorityBase, id, rule, trustedEdges),
                    derive(input.base, id, rule, []),
                    derive(input.head, id, rule, []),
                ];
                const proof = new Map();
                for (const scope of allScopes)
                    for (const [path, chain] of scope)
                        if (!proof.has(path) || chain.length < proof.get(path).length)
                            proof.set(path, chain);
                const scope = sorted(proof.keys());
                const selected = deltas.filter(d => d.kind.startsWith("resource_") &&
                    deltaPaths(d).some(path => proof.has(path)));
                const touched = sorted(new Set(selected.map(d => d.afterPath || d.beforePath || d.subject)));
                const activation = rule.activation === "requirement_cause" ? "requirement_cause" : "scoped_change";
                const active = activation === "requirement_cause" ? applicability.direct.has(id) : selected.length > 0;
                const token = "constraint:" + id + ":" + rule.id;
                let observed = null, verdict = active ? "PASS" : "NOT_APPLICABLE";
                if (active && rule.metric === "changed_resources") {
                    observed = selected.length;
                }
                else if (active && rule.metric === "changed_lines") {
                    let sum = 0, complete = true;
                    for (const path of touched) {
                        const number = observationMap.get("changed_lines\0" + path);
                        if (number === undefined) {
                            problems.push("I7:missing_observation:" + id + ":" + rule.id + ":" + path);
                            complete = false;
                        }
                        else
                            sum += number;
                    }
                    if (complete && Number.isSafeInteger(sum))
                        observed = sum;
                    else if (complete)
                        problems.push("I7:observation_overflow:" + id + ":" + rule.id);
                    if (observed === null)
                        verdict = "RED";
                }
                else if (active && rule.metric !== undefined) {
                    verdict = "RED";
                    problems.push("I7:missing_observation:" + id + ":" + rule.id + ":" + String(rule.metric));
                }
                if (observed !== null && observed > rule.max) {
                    if (granted(input, receipts, token))
                        verdict = "WAIVED";
                    else {
                        verdict = "RED";
                        problems.push("I7:constraint_exceeded:" + id + ":" + rule.id + ":" + observed + ">" + rule.max);
                    }
                }
                if (active && rule.evidence !== undefined) {
                    const spec = rule.evidence;
                    const verifierValid = spec.kind !== "execution" || (() => {
                        const headRelations = obj(root(input.head, id)?.relations);
                        return Object.values(headRelations || {}).some(value => {
                            const rel = obj(value), target = obj(rel?.target);
                            return rel?.predicate === "verified_by" && target?.kind === "artifact" && target.path === spec.verifierPath &&
                                (input.head.j1.owners[spec.verifierPath] || []).includes(id);
                        });
                    })();
                    const structurallyCompatible = facts.filter(f => f.key === spec.key && f.requirementId === id &&
                        (spec.providerId === undefined || f.providerId === spec.providerId) &&
                        f.authorityBaseRevision === input.trustedAuthorityBase.revision &&
                        f.baseRevision === input.base.revision && f.headRevision === input.head.revision &&
                        Array.isArray(f.subjectPaths) && f.subjectPaths.every(path => typeof path === "string") &&
                        stable(sorted(f.subjectPaths)) === stable(touched) &&
                        (spec.kind !== "execution" || (f.verifierPath === spec.verifierPath && f.verifierRevision === input.head.revision)));
                    const compatible = structurallyCompatible.filter(f => capabilityMode
                        ? evidenceProviderAuthorized(input, providerState.grants, f, spec, id, touched)
                        : (spec.providerId !== undefined && f.providerId === spec.providerId && providers.has(spec.providerId)));
                    if (capabilityMode && structurallyCompatible.length > 0 && compatible.length === 0)
                        problems.push("I7:unauthorized_evidence_provider:" + id + ":" + rule.id);
                    const statuses = new Set(compatible.map(f => f.status));
                    if (statuses.size > 1) {
                        verdict = "RED";
                        problems.push("I7:conflicting_evidence:" + id + ":" + rule.id);
                    }
                    if (!verifierValid || statuses.size !== 1 || !statuses.has("pass")) {
                        verdict = "RED";
                        problems.push("I7:missing_evidence:" + id + ":" + rule.id + ":" + spec.key);
                    }
                }
                explanations.push({ requirementId: id, constraintId: rule.id, basis: v.label,
                    activation, directApplicable: applicability.direct.has(id), selectedCause: applicability.selected.has(id),
                    reverseImpacted: applicability.reverseOnly.has(id),
                    rootedProof: input.trustedAuthorityBase.j2.explanations[id] || input.base.j2.explanations[id] || input.head.j2.explanations[id] || [],
                    exactTransition: { authorityBaseRevision: input.trustedAuthorityBase.revision, baseRevision: input.base.revision, headRevision: input.head.revision }, metric: rule.metric || null,
                    max: rule.max === undefined ? null : rule.max, scope, scopeProofs: Object.fromEntries([...proof.entries()].sort(([a], [b]) => a.localeCompare(b))),
                    touched, observed, observationSources: touched.filter(path => observationMap.has("changed_lines\0" + path)).map(path => ({
                        path, metric: "changed_lines", value: observationMap.get("changed_lines\0" + path),
                        providerId: observation.find(o => o.path === path && o.metric === "changed_lines")?.providerId || null
                    })),
                    requiredEvidence: rule.evidence || null,
                    requiredAuthority: { requirementId: id, constraintId: rule.id, permission: token }, verdict });
            }
        }
    }
    return { reasons: sorted(problems), constraints: explanations };
}
export function evaluateTransitionCauseClosure(input) {
    const reasons = [];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
        reasons.push("input:invalid_repository");
    reasons.push(...snapshotErrors("base", input.base, input.repository));
    reasons.push(...snapshotErrors("head", input.head, input.repository));
    reasons.push(...snapshotErrors("authority_base", input.trustedAuthorityBase, input.repository));
    if (!input.head.j1.ok)
        reasons.push("head:j1_not_closed");
    const normalizedResources = resourceDeltas(input.resourceDeltas || []);
    reasons.push(...normalizedResources.errors.map(x => "input:" + x));
    const protectedSet = new Set();
    for (const raw of input.protectedResources || []) {
        try {
            protectedSet.add(normPath(raw));
        }
        catch (error) {
            reasons.push("input:invalid_protected_resource:" + String(raw) + ":" + error.message);
        }
    }
    const baseRelationState = relations(input.base), headRelationState = relations(input.head);
    reasons.push(...baseRelationState.errors.map(x => "base:" + x), ...headRelationState.errors.map(x => "head:" + x));
    const baseRelations = baseRelationState.facts, headRelations = headRelationState.facts;
    const deltas = [...requirementDeltas(input.base, input.head), ...relationDeltas(baseRelations, headRelations),
        ...constraintDeltas(input.base, input.head), ...normalizedResources.deltas,
        ...lifecycleDeltas(input.baseLifecycle || {}, input.headLifecycle || {})].sort((a, b) => a.id.localeCompare(b.id, "en"));
    const ruleState = transitionRules(input.trustedAuthorityBase), rules = ruleState.rules;
    reasons.push(...ruleState.errors.map(x => "authority_base:" + x));
    const receiptState = validReceipts(input), evidenceState = validEvidence(input), intentState = workIntentAddresses(input.workIntent);
    reasons.push(...receiptState.errors.map(x => "input:" + x), ...evidenceState.errors.map(x => "input:" + x), ...intentState.errors.map(x => "input:" + x));
    const addresses = new Set(intentState.addresses);
    const authorityRooted = new Set(input.trustedAuthorityBase.j2.rooted);
    const whyChanged = [];
    const affectedAll = new Set();
    const directApplicableAll = new Set(), selectedCausesAll = new Set();
    for (const delta of deltas) {
        const matchedRules = rules.filter(rule => matchesRule(rule, delta)).sort((a, b) => a.requirementId.localeCompare(b.requirementId, "en"));
        const affectedIds = affected(delta, input.base, input.head, baseRelations, headRelations);
        for (const id of affectedIds)
            affectedAll.add(id);
        const structural = directCandidates(delta, input.base, input.head);
        for (const id of structural)
            directApplicableAll.add(id);
        const candidates = new Set(structural);
        for (const rule of matchedRules)
            candidates.add(rule.requirementId);
        const candidateIds = sorted(candidates);
        const causes = candidateIds.filter(id => addresses.has(id) && (authorityRooted.has(id) || granted(input, receiptState.receipts, "requirement:" + id)));
        for (const id of causes)
            selectedCausesAll.add(id);
        if (!causes.length)
            reasons.push("J3:no_cause:" + delta.id);
        const permissions = authorityPermissions(delta, input, protectedSet);
        for (const permission of permissions)
            if (!granted(input, receiptState.receipts, permission))
                reasons.push(`J3:missing_authority:${permission}:${delta.id}`);
        const evidenceKeys = sorted(matchedRules.flatMap(rule => rule.evidenceKeys || []));
        for (const key of evidenceKeys)
            if (!evidencePass(input, evidenceState.facts, key))
                reasons.push(`J3:missing_evidence:${key}:${delta.id}`);
        for (const rule of matchedRules)
            if (rule.requireAddressed === true && !addresses.has(rule.requirementId))
                reasons.push(`J3:unacknowledged_impact:${rule.requirementId}:${delta.id}`);
        whyChanged.push({ id: delta.id, kind: delta.kind, subject: delta.subject, affected: affectedIds, applicable: sorted(new Set([...affectedIds, ...matchedRules.map(r => r.requirementId)])),
            directApplicable: sorted(structural), reverseImpact: affectedIds.filter(id => !structural.has(id)),
            causalCandidates: candidateIds, causes: sorted(causes), requiredAuthority: permissions, requiredEvidence: evidenceKeys });
    }
    const reverseOnly = new Set([...affectedAll].filter(id => !directApplicableAll.has(id)));
    const scoped = evaluateScopedObligations(input, normalizedResources.deltas, receiptState.receipts, evidenceState.facts, { direct: directApplicableAll, selected: selectedCausesAll, reverseOnly });
    reasons.push(...scoped.reasons);
    const normalizedReasons = sorted(reasons);
    return { ok: normalizedReasons.length === 0, reasons: normalizedReasons, deltas: deltas.map(delta => ({ id: delta.id, kind: delta.kind, subject: delta.subject,
            ...(delta.beforePath ? { beforePath: delta.beforePath } : {}), ...(delta.afterPath ? { afterPath: delta.afterPath } : {}), ...(delta.field ? { field: delta.field } : {}),
            ...(delta.constraintId ? { constraintId: delta.constraintId } : {}) })),
        affectedRequirements: sorted(affectedAll), explanations: { whyChanged: whyChanged.sort((a, b) => a.id.localeCompare(b.id, "en")), constraints: scoped.constraints } };
}
