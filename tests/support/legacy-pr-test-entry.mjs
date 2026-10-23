// Test-only entrypoint for historical #791-deferred PR semantics.
// The published repo-guard CLI does not dispatch check-pr.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../../dist/repo-guard.mjs", import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === cli) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("check-pr");
  if (at >= 0) {
    let repoRoot = process.cwd(), enforcementMode = null;
    for (let index = 0; index < at; index++) {
      if (argv[index] === "--repo-root") repoRoot = resolve(argv[++index]);
      else if (argv[index] === "--enforcement") enforcementMode = argv[++index];
    }
    const { runCheckPR } = await import("../../dist/github-pr.mjs");
    const status = runCheckPR({
      repoRoot,
      packageRoot: fileURLToPath(new URL("../..", import.meta.url)),
      enforcementMode,
    }, argv.slice(at + 1));
    process.exit(status);
  }
}
