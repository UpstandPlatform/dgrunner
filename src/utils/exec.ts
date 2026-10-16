import type { SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions extends SpawnOptions {
  timeoutMs?: number;
  input?: string;
}

export function execCommand(
  cmd: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { timeoutMs, input, ...spawnOpts } = options;

    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        shell: false,
        ...spawnOpts,
      });
    } catch (err: any) {
      return resolve({
        exitCode: 1,
        stdout: "",
        stderr: err?.message || String(err),
      });
    }

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        stderr += `\nCommand timed out after ${timeoutMs}ms`;
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        forceKillTimer.unref();
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    if (child.stdin) {
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        exitCode: timedOut ? 1 : code ?? (signal ? 1 : 0),
        stdout: stdout.trim(),
        stderr: `${stderr}${timedOut && !stderr.includes("Command timed out") ? `\nCommand timed out after ${timeoutMs}ms` : ""}`.trim(),
      });
    });
  });
}

export function execInteractive(
  cmd: string,
  args: string[] = [],
  options: SpawnOptions = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      windowsHide: false,
      ...options,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });
}
