import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DEFAULT_BASE_DIR, DEFAULT_RUNNER_DIR } from "../config/constants.js";
import { execCommand } from "../utils/exec.js";
import {
  getDockerRunnerStatus,
  startDockerContainer,
  stopDockerRunner,
  restartDockerRunner,
  removeDockerRunner,
  tailDockerRunnerLogs,
} from "./docker-runner.js";

export interface RunnerMetadata {
  runnerDir: string;
  url: string;
  name: string;
  labels: string[];
  scope: "repo" | "org";
  configuredAt: string;
  os: string;
  arch: string;
  mode?: "native" | "docker" | "wsl";
  containerName?: string;
  distro?: string;
  image?: string;
}

export interface RunnerStatusInfo {
  installed: boolean;
  configured: boolean;
  runnerName?: string;
  targetUrl?: string;
  labels?: string[];
  serviceInstalled: boolean;
  serviceRunning: boolean;
  activePid?: number;
  mode?: "native" | "docker" | "wsl";
  containerName?: string;
  distro?: string;
  image?: string;
}

export function getRunnerConfigFile(baseDir = DEFAULT_BASE_DIR): string {
  return path.join(baseDir, "dgrunner-meta.json");
}

function getRunnerPidFile(runnerDir: string): string {
  const runnerKey = crypto.createHash("sha256").update(path.resolve(runnerDir).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(DEFAULT_BASE_DIR, `runner-${runnerKey}.pid`);
}

export function isRunnerInstalled(runnerDir = DEFAULT_RUNNER_DIR): boolean {
  const scriptName = process.platform === "win32" ? "config.cmd" : "config.sh";
  return fs.existsSync(path.join(runnerDir, scriptName));
}

export function isRunnerConfigured(runnerDir = DEFAULT_RUNNER_DIR): boolean {
  return fs.existsSync(path.join(runnerDir, ".runner"));
}

export async function readOfficialRunnerConfig(runnerDir = DEFAULT_RUNNER_DIR): Promise<any | null> {
  const runnerFile = path.join(runnerDir, ".runner");
  if (!fs.existsSync(runnerFile)) return null;

  try {
    const content = await fsPromises.readFile(runnerFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function readLocalMetadata(baseDir = DEFAULT_BASE_DIR): Promise<RunnerMetadata | null> {
  const metaFile = getRunnerConfigFile(baseDir);
  if (!fs.existsSync(metaFile)) return null;

  try {
    const content = await fsPromises.readFile(metaFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveLocalMetadata(meta: RunnerMetadata, baseDir = DEFAULT_BASE_DIR): Promise<void> {
  const metaFile = getRunnerConfigFile(baseDir);
  await fsPromises.mkdir(path.dirname(metaFile), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(metaFile, JSON.stringify(meta, null, 2), {
    mode: 0o600,
    encoding: "utf-8",
  });
}

/**
 * Resolves the Git Bash directory on Windows to ensure bash scripts run via Git Bash rather than WSL.
 */
export async function resolveGitBashDir(): Promise<string | null> {
  if (process.platform !== "win32") return null;

  // 1. Try finding where git.exe is installed
  const res = await execCommand("where.exe", ["git.exe"]);
  if (res.exitCode === 0 && res.stdout) {
    const gitPath = res.stdout.split(/\r?\n/)[0].trim();
    const gitRoot = path.dirname(path.dirname(gitPath));
    const binBash = path.join(gitRoot, "bin", "bash.exe");
    if (fs.existsSync(binBash)) return path.dirname(binBash);
    const usrBinBash = path.join(gitRoot, "usr", "bin", "bash.exe");
    if (fs.existsSync(usrBinBash)) return path.dirname(usrBinBash);
  }

  // 2. Common installation paths
  const commonCandidates = [
    "C:\\Program Files\\Git\\bin",
    "C:\\Program Files (x86)\\Git\\bin",
    path.join(os.homedir(), "AppData", "Local", "Programs", "Git", "bin"),
  ];

  for (const dir of commonCandidates) {
    if (fs.existsSync(path.join(dir, "bash.exe"))) {
      return dir;
    }
  }

  return null;
}

/**
 * Ensures the runner's .path file contains Git Bash (on Windows) so that workflow jobs
 * find Git Bash before Windows System32 bash (WSL).
 */
export async function ensureRunnerEnvironment(runnerDir = DEFAULT_RUNNER_DIR): Promise<void> {
  if (process.platform === "win32") {
    const gitBin = await resolveGitBashDir();
    if (gitBin) {
      const dotPath = path.join(runnerDir, ".path");
      let lines: string[] = [];
      if (fs.existsSync(dotPath)) {
        try {
          lines = (await fsPromises.readFile(dotPath, "utf-8")).split(/\r?\n/).filter(Boolean);
        } catch {}
      }
      if (!lines.includes(gitBin)) {
        lines.unshift(gitBin);
        await fsPromises.writeFile(dotPath, lines.join("\r\n") + "\r\n", "utf-8");
      }
    }
  }
}

/**
 * Configures the downloaded GitHub Actions runner.
 */
export interface ConfigureRunnerOptions {
  runnerDir?: string;
  url: string;
  token: string;
  name?: string;
  labels?: string[];
  workDir?: string;
  replace?: boolean;
  mode?: "native" | "docker" | "wsl";
  distro?: string;
}

export async function configureRunner(options: ConfigureRunnerOptions): Promise<{ success: boolean; output: string }> {
  const runnerDir = options.runnerDir || DEFAULT_RUNNER_DIR;
  const runnerName = options.name || `${os.hostname()}-dgrunner`;
  const workDir = options.workDir || "_work";
  const labelsStr = (options.labels && options.labels.length > 0)
    ? options.labels.join(",")
    : `self-hosted,dgrunner,${process.platform === "win32" ? "windows" : "linux"},${process.arch}`;

  await ensureRunnerEnvironment(runnerDir);

  const args: string[] = [
    "--unattended",
    "--url", options.url,
    "--token", options.token,
    "--name", runnerName,
    "--labels", labelsStr,
    "--work", workDir,
  ];

  if (options.replace) {
    args.push("--replace");
  }

  const script = process.platform === "win32" ? "config.cmd" : "./config.sh";
  const cmd = process.platform === "win32" ? path.join(runnerDir, script) : script;

  const result = await execCommand(cmd, args, {
    cwd: runnerDir,
    timeoutMs: 45000,
  });

  const success = result.exitCode === 0;

  if (success) {
    const scope = options.url.split("/").filter(Boolean).length === 4 ? "repo" : "org";
    await saveLocalMetadata({
      runnerDir,
      url: options.url,
      name: runnerName,
      labels: labelsStr.split(","),
      scope,
      configuredAt: new Date().toISOString(),
      os: process.platform,
      arch: process.arch,
      mode: options.mode || (process.platform === "win32" ? "native" : "native"),
      distro: options.distro,
    });
  }

  return {
    success,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

/**
 * Installs the persistent host service for the runner.
 */
export async function installService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  if (process.platform === "win32") {
    return {
      success: false,
      message: "Windows native mode is managed as a background process, not an installed Windows service.",
    };
  } else {
    // Linux svc.sh
    const svcPath = path.join(runnerDir, "svc.sh");
    if (fs.existsSync(svcPath)) {
      const res = await execCommand("sudo", ["./svc.sh", "install", os.userInfo().username], {
        cwd: runnerDir,
      });
      if (res.exitCode === 0) {
        return { success: true, message: "Systemd persistent service installed successfully." };
      }
      return { success: false, message: res.stderr || res.stdout };
    }
    return { success: false, message: "svc.sh not found in runner directory." };
  }
}

/**
 * Starts the runner persistent service or background process.
 */
export async function startService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  const localMeta = await readLocalMetadata();
  if (localMeta?.mode === "docker") {
    const res = await startDockerContainer(localMeta.containerName);
    return {
      success: res.success,
      message: res.success ? res.output : res.output,
    };
  }

  if (process.platform === "win32") {
    // Check if run.cmd exists
    const runCmd = path.join(runnerDir, "run.cmd");
    if (!fs.existsSync(runCmd)) {
      return { success: false, message: `Runner run.cmd not found at ${runCmd}` };
    }

    // Launch run.cmd in detached background mode if not already running
    await fsPromises.mkdir(DEFAULT_BASE_DIR, { recursive: true, mode: 0o700 });
    const pidFile = getRunnerPidFile(runnerDir);
    if (fs.existsSync(pidFile)) {
      const existingPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      const isAlive = !isNaN(existingPid) && await verifyWindowsRunnerProcess(existingPid, runnerDir);
      if (isAlive) {
        return { success: true, message: `Runner is already running with PID ${existingPid}.` };
      }
    }

    await ensureRunnerEnvironment(runnerDir);

    const gitBin = await resolveGitBashDir();
    const env = { ...process.env };
    if (gitBin) {
      env.PATH = `${gitBin};${env.PATH || ""}`;
    }

    const { spawn } = await import("node:child_process");
    const listenerExe = path.join(runnerDir, "bin", "Runner.Listener.exe");
    if (!fs.existsSync(listenerExe)) {
      return { success: false, message: `Runner listener executable not found at ${listenerExe}` };
    }
    const outLog = fs.openSync(path.join(DEFAULT_BASE_DIR, "runner-stdout.log"), "a", 0o600);
    const errLog = fs.openSync(path.join(DEFAULT_BASE_DIR, "runner-stderr.log"), "a", 0o600);

    const child = spawn(listenerExe, ["run"], {
      cwd: runnerDir,
      detached: true,
      stdio: ["ignore", outLog, errLog],
      windowsHide: true,
      env,
    });

    const spawnFailure = await new Promise<Error | undefined>((resolve) => {
      child.once("spawn", () => resolve(undefined));
      child.once("error", resolve);
    });
    if (spawnFailure) {
      fs.closeSync(outLog);
      fs.closeSync(errLog);
      return { success: false, message: `Failed to start runner: ${spawnFailure.message}` };
    }

    fs.closeSync(outLog);
    fs.closeSync(errLog);
    child.unref();

    if (child.pid) {
      fs.writeFileSync(pidFile, String(child.pid), "utf-8");
      return { success: true, message: `Runner started in background (PID: ${child.pid}).` };
    }

    return { success: false, message: "Failed to spawn runner process." };
  } else {
    // Linux svc.sh start
    const res = await execCommand("sudo", ["./svc.sh", "start"], { cwd: runnerDir });
    return {
      success: res.exitCode === 0,
      message: res.exitCode === 0 ? "Runner systemd service started." : (res.stderr || res.stdout),
    };
  }
}

/**
 * Stops the runner persistent service or background process.
 */
export async function stopService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  const localMeta = await readLocalMetadata();
  if (localMeta?.mode === "docker") {
    const res = await stopDockerRunner(localMeta.containerName);
    return {
      success: res.success,
      message: res.success
        ? `Docker runner container '${localMeta.containerName}' stopped.`
        : res.output,
    };
  }

  if (process.platform === "win32") {
    const pidFile = getRunnerPidFile(runnerDir);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        if (await verifyWindowsRunnerProcess(pid, runnerDir)) {
          const stopped = await execCommand("taskkill.exe", ["/pid", String(pid), "/t", "/f"]);
          if (stopped.exitCode !== 0) {
            return { success: false, message: stopped.stderr || stopped.stdout || "Failed to stop runner process." };
          }
        }
      }
      try {
        fs.unlinkSync(pidFile);
      } catch {}
    }

    return { success: true, message: "Runner service stopped." };
  } else {
    // Linux svc.sh stop
    const res = await execCommand("sudo", ["./svc.sh", "stop"], { cwd: runnerDir });
    return {
      success: res.exitCode === 0,
      message: res.exitCode === 0 ? "Runner systemd service stopped." : (res.stderr || res.stdout),
    };
  }
}

/**
 * Unregisters the runner and removes configuration.
 */
export async function removeRunner(
  runnerDir = DEFAULT_RUNNER_DIR,
  token: string
): Promise<{ success: boolean; output: string }> {
  const localMeta = await readLocalMetadata();
  if (localMeta?.mode === "docker") {
    const res = await removeDockerRunner(token, localMeta.containerName);
    const metaFile = getRunnerConfigFile();
    if (res.success && fs.existsSync(metaFile)) {
      try {
        fs.unlinkSync(metaFile);
      } catch {}
    }
    return res;
  }

  // Stop service first
  await stopService(runnerDir).catch(() => {});

  if (process.platform !== "win32") {
    const svcPath = path.join(runnerDir, "svc.sh");
    if (fs.existsSync(svcPath)) {
      await execCommand("sudo", ["./svc.sh", "uninstall"], { cwd: runnerDir }).catch(() => {});
    }
  }

  const script = process.platform === "win32" ? "config.cmd" : "./config.sh";
  const cmd = process.platform === "win32" ? path.join(runnerDir, script) : script;

  const result = await execCommand(cmd, ["remove", "--token", token], {
    cwd: runnerDir,
    timeoutMs: 30000,
  });

  const metaFile = getRunnerConfigFile();
  if (result.exitCode === 0 && fs.existsSync(metaFile)) {
    try {
      fs.unlinkSync(metaFile);
    } catch {}
  }

  return {
    success: result.exitCode === 0,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

/**
 * Gets comprehensive status of the runner.
 */
export async function getRunnerStatus(runnerDir = DEFAULT_RUNNER_DIR): Promise<RunnerStatusInfo> {
  const localMeta = await readLocalMetadata();
  if (localMeta?.mode === "docker") {
    const dStatus = await getDockerRunnerStatus(localMeta.containerName);
    return {
      installed: dStatus.exists,
      configured: dStatus.exists,
      runnerName: localMeta.name,
      targetUrl: localMeta.url,
      labels: localMeta.labels,
      serviceInstalled: dStatus.exists,
      serviceRunning: dStatus.running,
      mode: "docker",
      containerName: localMeta.containerName,
      distro: localMeta.distro,
      image: localMeta.image,
    };
  }

  const installed = isRunnerInstalled(runnerDir);
  const configured = isRunnerConfigured(runnerDir);
  const officialConfig = await readOfficialRunnerConfig(runnerDir);

  let serviceRunning = false;
  let activePid: number | undefined;

  if (process.platform === "win32") {
    const pidFile = getRunnerPidFile(runnerDir);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        if (await verifyWindowsRunnerProcess(pid, runnerDir)) {
          serviceRunning = true;
          activePid = pid;
        } else {
          await fsPromises.unlink(pidFile).catch(() => {});
        }
      }
    }
  } else {
    // Linux svc status
    const svcRes = await execCommand("sudo", ["./svc.sh", "status"], { cwd: runnerDir });
    serviceRunning = svcRes.exitCode === 0 && svcRes.stdout.toLowerCase().includes("active (running)");
  }

  return {
    installed,
    configured,
    runnerName: officialConfig?.runnerName || localMeta?.name,
    targetUrl: officialConfig?.serverUrl || localMeta?.url,
    labels: localMeta?.labels,
    serviceInstalled: process.platform === "win32" ? false : configured,
    serviceRunning,
    activePid,
    mode: localMeta?.mode,
    distro: localMeta?.distro,
    image: localMeta?.image,
  };
}

async function verifyWindowsRunnerProcess(pid: number, runnerDir: string): Promise<boolean> {
  const result = await execCommand("powershell.exe", ["-NoProfile", "-Command", [
    "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = $env:DGRUNNER_PID\"",
    "if ($p -and $p.ExecutablePath -and ([IO.Path]::GetFullPath($p.ExecutablePath) -ieq [IO.Path]::GetFullPath($env:DGRUNNER_EXECUTABLE))) { exit 0 }",
    "exit 2",
  ].join("; ")], {
    env: {
      ...process.env,
      DGRUNNER_PID: String(pid),
      DGRUNNER_EXECUTABLE: path.join(runnerDir, "bin", "Runner.Listener.exe"),
    },
  });
  return result.exitCode === 0;
}

export interface ActiveProcessInfo {
  pid: number | string;
  name: string;
  runnerName?: string;
  targetUrl?: string;
  memoryMb?: number;
  status: string;
}

/**
 * Runs the runner attached in the foreground, streaming stdout/stderr in real time.
 */
export async function runForeground(runnerDir = DEFAULT_RUNNER_DIR): Promise<number> {
  const localMeta = await readLocalMetadata();
  if (localMeta?.mode === "docker") {
    const container = localMeta.containerName || "upstand-dgrunner-linux";
    // Check if container is running; if not, restart it
    const status = await getDockerRunnerStatus(container);
    if (!status.running) {
      const started = await startDockerContainer(container);
      if (!started.success) {
        console.error(started.output);
        return 1;
      }
    }
    await tailDockerRunnerLogs(container, true);
    return 0;
  }

  await ensureRunnerEnvironment(runnerDir);

  const { spawn } = await import("node:child_process");

  let execFile = "";
  let execArgs: string[] = [];
  const env = { ...process.env };

  if (process.platform === "win32") {
    const gitBin = await resolveGitBashDir();
    if (gitBin) {
      env.PATH = `${gitBin};${env.PATH || ""}`;
    }
    const listenerExe = path.join(runnerDir, "bin", "Runner.Listener.exe");
    if (fs.existsSync(listenerExe)) {
      execFile = listenerExe;
      execArgs = ["run"];
    } else {
      execFile = "cmd.exe";
      execArgs = ["/c", path.join(runnerDir, "run.cmd")];
    }
  } else {
    execFile = path.join(runnerDir, "run.sh");
    execArgs = [];
  }

  return new Promise((resolve) => {
    const child = spawn(execFile, execArgs, {
      cwd: runnerDir,
      stdio: "inherit",
      env,
    });

    const cleanup = () => {
      try {
        child.kill("SIGINT");
      } catch {}
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    child.on("close", (code) => {
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      resolve(code ?? 0);
    });
    child.on("error", () => {
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      resolve(1);
    });
  });
}

/**
 * Lists active runner processes on the host and Docker containers.
 */
export async function listRunnerProcesses(runnerDir = DEFAULT_RUNNER_DIR): Promise<ActiveProcessInfo[]> {
  const officialConfig = await readOfficialRunnerConfig(runnerDir);
  const localMeta = await readLocalMetadata();
  const runnerName = officialConfig?.runnerName || localMeta?.name || "dgrunner";
  const targetUrl = officialConfig?.serverUrl || localMeta?.url || "Unknown";

  const results: ActiveProcessInfo[] = [];

  // 1. Check Docker runner containers
  try {
    const dockerPs = await execCommand("docker", [
      "ps",
      "--filter", "name=upstand-dgrunner",
      "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}",
    ]);
    if (dockerPs.exitCode === 0 && dockerPs.stdout.trim()) {
      const lines = dockerPs.stdout.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const [id, name, status, image] = line.split("\t");
        if (id && name) {
          results.push({
            pid: id.slice(0, 12),
            name: `${name} (docker)`,
            runnerName: localMeta?.name || name,
            targetUrl: localMeta?.url || targetUrl,
            status: status || "Up (healthy)",
          });
        }
      }
    }
  } catch {}

  // 2. Check Host processes
  if (process.platform === "win32") {
    const psCmd = `Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, WorkingSet64 | ConvertTo-Json -Compress`;
    const res = await execCommand("powershell.exe", ["-NoProfile", "-Command", psCmd]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      try {
        const parsed = JSON.parse(res.stdout);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (item && item.Id) {
            results.push({
              pid: item.Id,
              name: item.ProcessName || "Runner.Listener",
              runnerName,
              targetUrl,
              memoryMb: item.WorkingSet64 ? Math.round(item.WorkingSet64 / (1024 * 1024)) : undefined,
              status: "Listening",
            });
          }
        }
      } catch {}
    }
  } else {
    // Linux
    const res = await execCommand("pgrep", ["-a", "Runner.Listener"]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      const lines = res.stdout.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid)) {
          results.push({
            pid,
            name: parts[1] || "Runner.Listener",
            runnerName,
            targetUrl,
            status: "Listening",
          });
        }
      }
    }
  }

  return results;
}

/**
 * Follows/tails runner log output.
 */
export async function tailRunnerLogs(options: { follow?: boolean; lines?: number; baseDir?: string } = {}): Promise<void> {
  const localMeta = await readLocalMetadata(options.baseDir);
  if (localMeta?.mode === "docker") {
    await tailDockerRunnerLogs(localMeta.containerName, options.follow);
    return;
  }

  const baseDir = options.baseDir || DEFAULT_BASE_DIR;
  const logFile = path.join(baseDir, "runner-stdout.log");

  if (!fs.existsSync(logFile)) {
    console.log("No runner log file found at " + logFile);
    return;
  }

  const linesCount = options.lines || 50;
  const content = await fsPromises.readFile(logFile, "utf-8");
  const allLines = content.split(/\r?\n/);
  const tailLines = allLines.slice(-linesCount);
  for (const line of tailLines) {
    console.log(line);
  }

  if (options.follow) {
    console.log("\n--- Following live logs (Press Ctrl+C to detach) ---");
    let currentSize = (await fsPromises.stat(logFile)).size;

    const interval = setInterval(async () => {
      try {
        const stats = await fsPromises.stat(logFile);
        if (stats.size > currentSize) {
          const stream = fs.createReadStream(logFile, { start: currentSize, end: stats.size });
          stream.on("data", (chunk) => {
            process.stdout.write(chunk.toString());
          });
          currentSize = stats.size;
        }
      } catch {}
    }, 1000);

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        clearInterval(interval);
        console.log("\nDetached from runner logs.");
        resolve();
      });
    });
  }
}
