import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_BASE_DIR, DEFAULT_RUNNER_DIR } from "../config/constants.js";
import { execCommand } from "../utils/exec.js";

export interface RunnerMetadata {
  runnerDir: string;
  url: string;
  name: string;
  labels: string[];
  scope: "repo" | "org";
  configuredAt: string;
  os: string;
  arch: string;
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
}

export function getRunnerConfigFile(baseDir = DEFAULT_BASE_DIR): string {
  return path.join(baseDir, "dgrunner-meta.json");
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
export async function configureRunner(options: {
  runnerDir?: string;
  url: string;
  token: string;
  name?: string;
  labels?: string[];
  workDir?: string;
  replace?: boolean;
}): Promise<{ success: boolean; output: string }> {
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
    // Windows runner uses runner process or PowerShell scheduled task/service
    // The official runner win-x64 includes service installation via config.cmd --runasservice or running run.cmd
    // But if already configured, we can install service via PowerShell or runner's action service
    // Let's check for runner's bin/RunnerListener or service install
    const serviceScript = path.join(runnerDir, "bin", "RunnerListener.exe");
    if (fs.existsSync(serviceScript)) {
      return {
        success: true,
        message: "Runner service is ready. Launch with 'dgrunner start' or run.cmd",
      };
    }
    return { success: true, message: "Windows service configuration complete." };
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
  if (process.platform === "win32") {
    // Check if run.cmd exists
    const runCmd = path.join(runnerDir, "run.cmd");
    if (!fs.existsSync(runCmd)) {
      return { success: false, message: `Runner run.cmd not found at ${runCmd}` };
    }

    // Launch run.cmd in detached background mode if not already running
    const pidFile = path.join(DEFAULT_BASE_DIR, "runner.pid");
    if (fs.existsSync(pidFile)) {
      const existingPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      const isAlive = await isPidAlive(existingPid);
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
    const outLog = fs.openSync(path.join(DEFAULT_BASE_DIR, "runner-stdout.log"), "a");
    const errLog = fs.openSync(path.join(DEFAULT_BASE_DIR, "runner-stderr.log"), "a");

    const listenerExe = path.join(runnerDir, "bin", "Runner.Listener.exe");
    const execFile = fs.existsSync(listenerExe) ? listenerExe : "cmd.exe";
    const execArgs = fs.existsSync(listenerExe) ? ["run"] : ["/c", runCmd];

    const child = spawn(execFile, execArgs, {
      cwd: runnerDir,
      detached: true,
      stdio: ["ignore", outLog, errLog],
      windowsHide: true,
      env,
    });

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
  if (process.platform === "win32") {
    // Terminate Runner.Listener.exe if active
    await execCommand("taskkill.exe", ["/f", "/im", "Runner.Listener.exe"]).catch(() => {});

    const pidFile = path.join(DEFAULT_BASE_DIR, "runner.pid");
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process might already be dead
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
  if (fs.existsSync(metaFile)) {
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
  const installed = isRunnerInstalled(runnerDir);
  const configured = isRunnerConfigured(runnerDir);
  const officialConfig = await readOfficialRunnerConfig(runnerDir);
  const localMeta = await readLocalMetadata();

  let serviceRunning = false;
  let activePid: number | undefined;

  if (process.platform === "win32") {
    const taskRes = await execCommand("tasklist.exe", [
      "/fi", "IMAGENAME eq Runner.Listener.exe",
      "/fo", "csv",
      "/nh",
    ]);
    if (taskRes.exitCode === 0 && taskRes.stdout.includes("Runner.Listener.exe")) {
      serviceRunning = true;
      const match = taskRes.stdout.match(/"Runner\.Listener\.exe","(\d+)"/i);
      if (match && match[1]) {
        activePid = parseInt(match[1], 10);
      }
    } else {
      const pidFile = path.join(DEFAULT_BASE_DIR, "runner.pid");
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        if (!isNaN(pid) && (await isPidAlive(pid))) {
          serviceRunning = true;
          activePid = pid;
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
    serviceInstalled: configured,
    serviceRunning,
    activePid,
  };
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
