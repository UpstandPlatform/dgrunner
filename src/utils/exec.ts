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

const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = "\n[output truncated after 1048576 bytes]";

function captureChunk(chunks: Buffer[], chunk: unknown, currentBytes: number): number {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
  const remaining = MAX_CAPTURED_OUTPUT_BYTES - currentBytes;
  if (remaining <= 0) return currentBytes;
  const captured = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
  chunks.push(captured);
  return currentBytes + captured.length;
}

function decodeCapturedOutput(chunks: Buffer[], isTruncated: boolean): string {
  const output = Buffer.concat(chunks).toString("utf8");
  return isTruncated ? output + OUTPUT_TRUNCATION_MARKER : output;
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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        forceKillTimer.unref();
      }, timeoutMs);
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutTruncated ||= stdoutBytes + bytes.length > MAX_CAPTURED_OUTPUT_BYTES;
        stdoutBytes = captureChunk(stdoutChunks, bytes, stdoutBytes);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrTruncated ||= stderrBytes + bytes.length > MAX_CAPTURED_OUTPUT_BYTES;
        stderrBytes = captureChunk(stderrChunks, bytes, stderrBytes);
      });
    }

    if (child.stdin) {
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") {
          stderrTruncated ||= stderrBytes + Buffer.byteLength(err.message) > MAX_CAPTURED_OUTPUT_BYTES;
          stderrBytes = captureChunk(stderrChunks, err.message, stderrBytes);
        }
      });
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const stdout = decodeCapturedOutput(stdoutChunks, stdoutTruncated);
      const stderr = decodeCapturedOutput(stderrChunks, stderrTruncated);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr || err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const stdout = decodeCapturedOutput(stdoutChunks, stdoutTruncated);
      let stderr = decodeCapturedOutput(stderrChunks, stderrTruncated);
      if (timedOut && !stderr.includes("Command timed out")) {
        stderr += `\nCommand timed out after ${timeoutMs}ms`;
      }
      resolve({
        exitCode: timedOut ? 1 : code ?? (signal ? 1 : 0),
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
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      windowsHide: false,
      ...options,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
