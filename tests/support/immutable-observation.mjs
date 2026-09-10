import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const localCache = new Map();

function observationKey(command, args, options) {
  return JSON.stringify([
    command,
    args,
    resolve(options.cwd ?? process.cwd()),
  ]);
}

function sharedPath(key) {
  const dir = process.env.REPO_GUARD_TEST_OBSERVATION_CACHE_DIR;
  return dir
    ? join(dir, `${createHash("sha256").update(key).digest("hex")}.stdout`)
    : null;
}

export function observeImmutable(command, args, options = {}) {
  const key = observationKey(command, args, options);
  if (localCache.has(key)) return localCache.get(key);

  const path = sharedPath(key);
  if (path && existsSync(path)) {
    const cached = readFileSync(path, "utf8");
    localCache.set(key, cached);
    return cached;
  }

  const observed = execFileSync(command, args, {
    ...options,
    encoding: "utf8",
  }).trim();
  if (path) writeFileSync(path, observed, { encoding: "utf8", flag: "wx" });
  localCache.set(key, observed);
  return observed;
}
