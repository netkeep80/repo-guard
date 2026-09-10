import { format } from "node:util";
import { runCli } from "../../dist/repo-guard.mjs";

function capturedLine(values) {
  return format(...values);
}

export async function runCliCaptured(args = [], { env = {} } = {}) {
  const stdoutLines = [];
  const stderrLines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const previousEnv = new Map();

  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, {
      existed: Object.prototype.hasOwnProperty.call(process.env, key),
      value: process.env[key],
    });
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  console.log = (...values) => stdoutLines.push(capturedLine(values));
  console.error = (...values) => stderrLines.push(capturedLine(values));
  console.warn = (...values) => stderrLines.push(capturedLine(values));

  try {
    const code = await runCli([...args]);
    const stdout = stdoutLines.length ? `${stdoutLines.join("\n")}\n` : "";
    const stderr = stderrLines.length ? `${stderrLines.join("\n")}\n` : "";
    return { code, stdout, stderr, output: `${stdout}${stderr}` };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    for (const [key, previous] of previousEnv) {
      if (previous.existed) process.env[key] = previous.value;
      else delete process.env[key];
    }
  }
}
