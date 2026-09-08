const CHANGE_INTENT_ANCHOR_FIELDS = ["affects", "implements", "verifies"];
function cloneAnchorInstance(instance) {
    return { ...instance };
}
function sortedUnique(values) {
    return [...new Set((values || []).map((value) => String(value)))].sort();
}
function groupByType(anchorTypes, instances) {
    const byType = {};
    for (const anchorType of Object.keys(anchorTypes || {}).sort()) {
        byType[anchorType] = { detected: 0, changed: 0 };
    }
    for (const instance of instances.detected) {
        if (!byType[instance.anchorType])
            byType[instance.anchorType] = { detected: 0, changed: 0 };
        byType[instance.anchorType].detected++;
    }
    for (const instance of instances.changed) {
        if (!byType[instance.anchorType])
            byType[instance.anchorType] = { detected: 0, changed: 0 };
        byType[instance.anchorType].changed++;
    }
    return byType;
}
function declaredChangeIntentAnchors(changeIntent) {
    const changeIntentAnchors = changeIntent?.anchors || {};
    const declared = {};
    const all = [];
    for (const field of CHANGE_INTENT_ANCHOR_FIELDS) {
        const values = sortedUnique(changeIntentAnchors[field]);
        declared[field] = values;
        for (const value of values) {
            all.push({ relation: field, value });
        }
    }
    declared.all = all;
    return declared;
}
export function buildAnchorDiagnostics(facts) {
    if (!facts.policy.anchors)
        return {};
    const detected = (facts.anchors?.instances || []).map(cloneAnchorInstance);
    const changedPaths = new Set(facts.derived.changedPaths || []);
    const changed = detected
        .filter((instance) => changedPaths.has(instance.file))
        .map(cloneAnchorInstance);
    const declaredByChangeIntent = declaredChangeIntentAnchors(facts.changeIntent);
    return {
        anchors: {
            detected,
            changed,
            declaredByChangeIntent,
            stats: {
                detected: detected.length,
                changed: changed.length,
                declaredByChangeIntent: declaredByChangeIntent.all.length,
                extractionErrors: (facts.anchors?.errors || []).length,
                byType: groupByType(facts.policy.anchors.types, { detected, changed }),
            },
        },
    };
}
