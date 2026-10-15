import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions extends SpawnOptions {
  timeoutMs?: number;
  input?: string;
  hideError?: boolean;
}

export function execCommand(
  cmd: string,
  args: string[] = [],
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { timeoutMs, input, hideError, ...spawnOpts } = options;

    let actualCmd = cmd;
    let actualArgs = args;

    if (process.platform === "win32" && (cmd.endsWith(".cmd") || cmd.endsWith(".bat"))) {
      actualCmd = process.env.COMSPEC || "cmd.exe";
      actualArgs = ["/d", "/c", cmd, ...args];
    }

    let child;
    try {
      child = spawn(actualCmd, actualArgs, {
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

    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        stderr += `\nCommand timed out after ${timeoutMs}ms`;
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

    if (input && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || err.message,
      });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
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
    let actualCmd = cmd;
    let actualArgs = args;

    if (process.platform === "win32" && (cmd.endsWith(".cmd") || cmd.endsWith(".bat"))) {
      actualCmd = process.env.COMSPEC || "cmd.exe";
      actualArgs = ["/d", "/c", cmd, ...args];
    }

    const child = spawn(actualCmd, actualArgs, {
      stdio: "inherit",
      shell: false,
      windowsHide: false,
      ...options,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });
}
