import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { evaluateCompiler, type CompilerSnapshotObservation } from "./compiler-core.mjs";
import { listTrackedEntriesAtRef, readFileBytesAtRef, runGit } from "./git.mjs";
import {
  CHANGED_LINES_SEMANTICS,
  type TransitionObservationFact,
} from "./runtime/transition-closure.mjs";

const sha40 = /^[0-9a-f]{40}$/;

function resolveCommit(root: string, ref: string): string {
  if (!sha40.test(ref)) throw new Error("Git revision must be a literal lowercase 40-hex commit SHA");
  const resolved = runGit(["rev-parse", "--verify", ref + "^{commit}"], { cwd: root }).trim();
  if (!sha40.test(resolved)) throw new Error("Git revision is not an exact SHA-1 commit");
  if (resolved !== ref) throw new Error("Git revision resolved to a different commit identity");
  return resolved;
}

function parseChangedLinesZ(raw: string): Map<string, number> {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const result = new Map<string, number>();
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    const match = record?.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) throw new Error("malformed git --numstat -z record");
    const [, addedRaw, deletedRaw, inlinePath] = match;
    let path = inlinePath;
    if (path === "") {
      const before = fields[index++], after = fields[index++];
      if (before === undefined || after === undefined || after === "") throw new Error("malformed renamed git --numstat -z record");
      path = after;
    }
    if (addedRaw === "-" || deletedRaw === "-") continue;
    const value = Number(addedRaw) + Number(deletedRaw);
    if (!Number.isSafeInteger(value)) throw new Error("git changed_lines overflow");
    if (result.has(path)) throw new Error("duplicate git --numstat path " + path);
    result.set(path, value);
  }
  return result;
}

const isolatedGitEnvironmentKeys = new Set([
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR_SOURCE",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NAMESPACE",
  "GIT_TEMPLATE_DIR",
  "GIT_DEFAULT_HASH",
]);

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isolatedGitEnvironmentKeys.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
  env.GIT_ATTR_NOSYSTEM = "1";
  return env;
}

function deterministicChangedLines(root: string, base: string, head: string): string {
  const env = isolatedGitEnvironment();
  const objectPath = runGit(["rev-parse", "--git-path", "objects"], { cwd: root, env }).trim();
  if (!objectPath) throw new Error("cannot resolve Git object directory");
  const objectDirectory = isAbsolute(objectPath) ? objectPath : resolve(root, objectPath);
  const tempRoot = mkdtempSync(join(tmpdir(), "repo-guard-lines-"));
  const gitDir = join(tempRoot, "repo.git");
  const templateDir = join(tempRoot, "empty-template");
  try {
    mkdirSync(templateDir);
    runGit([
      "init",
      "--bare",
      "--object-format=sha1",
      `--template=${templateDir}`,
      "-q",
      gitDir,
    ], { cwd: root, env });
    const diffEnv = { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory };
    return runGit([
      `--git-dir=${gitDir}`,
      `--attr-source=${head}`,
      "-c", "core.quotepath=false",
      "-c", `core.attributesFile=${devNull}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--no-renames",
      "--numstat",
      "-z",
      base,
      head,
    ], { cwd: root, env: diffEnv });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function localObservations(repository: string, base: string, head: string, raw: string): TransitionObservationFact[] {
  return [...parseChangedLinesZ(raw)].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, value]) => ({
    authorityBaseRevision: base,
    baseRevision: base,
    headRevision: head,
    path,
    metric: "changed_lines" as const,
    semantics: CHANGED_LINES_SEMANTICS,
    value,
  }));
}

function acquireLocalSnapshot(root: string, repository: string, revision: string): CompilerSnapshotObservation {
  const entries = listTrackedEntriesAtRef(revision, root);
  const tracked = new Set(entries.map(entry => entry.path));
  const treeIdentity = runGit(["rev-parse", "--verify", revision + "^{tree}"], { cwd: root }).trim();
  if (!sha40.test(treeIdentity)) throw new Error("Git tree is not an exact SHA-1 identity");
  return {
    repository,
    revision,
    treeIdentity,
    complete: true,
    entries,
    readBytes: (path) =>
      tracked.has(path) ? readFileBytesAtRef(revision, path, root) : null,
  };
}

export function evaluateLocalCompiler(input: { root: string; repository: string; base: string; head: string }) {
  const base = resolveCommit(input.root, input.base);
  const head = resolveCommit(input.root, input.head);
  const snapshots = new Map<string, CompilerSnapshotObservation>();
  const snapshot = (revision: string) => {
    const existing = snapshots.get(revision);
    if (existing) return existing;
    const acquired = acquireLocalSnapshot(input.root, input.repository, revision);
    snapshots.set(revision, acquired);
    return acquired;
  };
  const before = snapshot(base);
  const after = snapshot(head);
  const evaluate = (observationFacts: readonly TransitionObservationFact[]) => evaluateCompiler({
    repository: input.repository,
    base: before,
    head: after,
    transition: { observationFacts },
  });
  const initial = evaluate([]);
  const needsChangedLines = initial.diagnostics.some(item =>
    item.code === "j3" && item.subject.startsWith("I7:missing_observation:"));
  if (!needsChangedLines) return initial;
  return evaluate(localObservations(
    input.repository,
    base,
    head,
    deterministicChangedLines(input.root, base, head),
  ));
}

export function runLocalCheck(roots: { repoRoot: string }, args: string[]): number {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const base = option("--base"), head = option("--head");
  if (!base || !head) throw new Error("check requires --base and --head");
  const format = option("--format") || "text";
  if (!["text", "json", "summary"].includes(format)) throw new Error("unsupported check format");

  const repository = "local/repository";
  const report = evaluateLocalCompiler({ root: roots.repoRoot, repository, base, head });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`RepoGuard check: ${report.ok ? "GREEN" : "RED"}; BASE=${report.base}; HEAD=${report.head}`);
    console.log(`J1 ${report.j1.justified}/${report.j1.tracked}; J2 ${report.j2.rooted}; J3 changes ${report.j3.changed}; diagnostics ${report.diagnostics.length}`);
    if (report.projections) {
      const projections = report.projections;
      const current = projections.analyses.filter((item) => item.freshness === "CURRENT").length;
      const stale = projections.analyses.filter((item) => item.freshness === "STALE").length;
      const broken = projections.analyses.filter((item) => item.freshness === "BROKEN").length;
      console.log(
        `P current ${current}; stale ${stale}; broken ${broken}; ownership ${projections.ownership.ok ? "GREEN" : "RED"}; coverage ${projections.ownership.coverage.status}`,
      );
    }
    if (format === "text")
      for (const item of report.diagnostics)
        console.log(`${item.code}: ${item.subject}${item.detail ? " (" + item.detail + ")" : ""}`);
  }
  return report.ok ? 0 : 1;
}
