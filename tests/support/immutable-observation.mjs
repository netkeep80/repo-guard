import { execFileSync } from "node:child_process";

export function observeImmutable(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    ...options,
  }).trim();
}
