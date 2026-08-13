export type EnforcementMode = "advisory" | "blocking";
export type EnforcementSource = "cli" | "policy" | "default";
type EnforcementInput = string | number | boolean | bigint | object | null | undefined;

export type NormalizeEnforcementModeResult =
  | { ok: false; message: string }
  | { ok: true; mode: EnforcementMode };

export type ResolveEnforcementModeResult =
  | { ok: false; message: string }
  | { ok: true; mode: EnforcementMode; source: EnforcementSource; requested: EnforcementInput };

interface EnforcementPolicyProjection {
  enforcement?: { mode?: EnforcementInput } | null;
}

interface ResolveEnforcementModeInput {
  cliValue?: EnforcementInput;
  policy?: EnforcementPolicyProjection | null;
}

const MODE_ALIASES = new Map<string, EnforcementMode>([
  ["advisory", "advisory"],
  ["warn", "advisory"],
  ["blocking", "blocking"],
  ["enforce", "blocking"],
]);

export function normalizeEnforcementMode(value: EnforcementInput, label = "enforcement"): NormalizeEnforcementModeResult {
  const raw = String(value || "").trim().toLowerCase();
  const mode = MODE_ALIASES.get(raw);
  if (!mode) {
    return {
      ok: false,
      message: `Unknown ${label}: ${value}. Must be one of: advisory, warn, blocking, enforce.`,
    };
  }
  return { ok: true, mode };
}

export function resolveEnforcementMode({ cliValue, policy }: ResolveEnforcementModeInput): ResolveEnforcementModeResult {
  const policyValue = policy?.enforcement?.mode;
  const raw = cliValue || policyValue || "blocking";
  const source: EnforcementSource = cliValue ? "cli" : policyValue ? "policy" : "default";
  const result = normalizeEnforcementMode(raw, "enforcement mode");
  if (!result.ok) return result;
  return { ok: true, mode: result.mode, source, requested: raw };
}
