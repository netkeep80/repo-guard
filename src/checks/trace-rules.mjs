function formatAnchorLocation(instance) {
  const line = instance.line ? `:${instance.line}` : "";
  const column = instance.column ? `:${instance.column}` : "";
  return `${instance.file}${line}${column}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function checkTraceRuleResult(result) {
  const unresolvedAnchors = (result.unresolved || []).map((item) => {
    const instances = item.instances || [];
    return {
      value: item.value,
      fromAnchorType: result.fromAnchorType,
      toAnchorType: result.toAnchorType,
      locations: instances.map(formatAnchorLocation),
      instances,
    };
  });

  const details = [];
  for (const anchor of unresolvedAnchors) {
    for (const location of anchor.locations) {
      details.push(`${anchor.value} (${anchor.fromAnchorType} -> ${anchor.toAnchorType}) at ${location}`);
    }
  }

  return {
    ok: unresolvedAnchors.length === 0,
    message: unresolvedAnchors.length > 0
      ? `unresolved anchor reference(s) for trace rule "${result.id}"`
      : undefined,
    trace_rule: result.id,
    trace_kind: result.kind,
    from_anchor_type: result.fromAnchorType,
    to_anchor_type: result.toAnchorType,
    unresolved_anchors: unresolvedAnchors,
    files: uniqueSorted(unresolvedAnchors.flatMap((anchor) =>
      anchor.instances.map((instance) => instance.file)
    )),
    details,
  };
}
