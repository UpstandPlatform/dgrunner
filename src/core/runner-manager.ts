import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";
import { DEFAULT_BASE_DIR, DEFAULT_RUNNER_DIR } from "../config/constants.js";
import { execCommand, execInteractive } from "../utils/exec.js";
import { ensureDir } from "../utils/fs.js";
import { redactSecret } from "../utils/logger.js";
import {
  normalizeRunnerLabels,
  validateGitHubUrl,
  validateRegistrationToken,
  validateRunnerLabels,
  validateRunnerName,
} from "./security.js";
import {
  getValidatedLinuxServiceUnit,
  getLinuxRunnerServiceStatus,
  installLinuxRunnerService,
  readLinuxServiceUnit,
  startLinuxRunnerService,
  stopLinuxRunnerService,
  uninstallLinuxRunnerService,
} from "./linux-service.js";
import {
  DEFAULT_CONTAINER_NAME,
  DGRUNNER_MANAGED_LABEL,
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

function getRunnerRegistryDir(baseDir = DEFAULT_BASE_DIR): string {
  return path.join(baseDir, "runners");
}

function runnerMetadataIdentity(metadata: RunnerMetadata): string {
  if (metadata.mode === "docker") {
    const containerName = metadata.containerName || metadata.runnerDir.replace(/^docker:/, "");
    return `docker:${containerName}`;
  }
  return "native:" + normalizeRunnerPath(metadata.runnerDir);
}

function normalizeRunnerPath(runnerDir: string): string {
  const resolved = path.resolve(runnerDir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getRunnerMetadataFile(metadata: RunnerMetadata, baseDir = DEFAULT_BASE_DIR): string {
  const key = crypto.createHash("sha256").update(runnerMetadataIdentity(metadata)).digest("hex");
  return path.join(getRunnerRegistryDir(baseDir), `${key}.json`);
}

function getRunnerPidFile(runnerDir: string): string {
  const runnerKey = crypto.createHash("sha256").update(normalizeRunnerPath(runnerDir)).digest("hex").slice(0, 16);
  return path.join(DEFAULT_BASE_DIR, `runner-${runnerKey}.pid`);
}

export function isRunnerInstalled(runnerDir = DEFAULT_RUNNER_DIR): boolean {
  const scriptName = process.platform === "win32" ? "config.cmd" : "config.sh";
  return fs.existsSync(path.join(runnerDir, scriptName));
}

export function isRunnerConfigured(runnerDir = DEFAULT_RUNNER_DIR): boolean {
  return fs.existsSync(path.join(runnerDir, ".runner"));
}

function getRunnerStartError(runnerDir: string): string | undefined {
  const configScript = process.platform === "win32" ? "config.cmd" : "config.sh";
  const startScript = process.platform === "win32" ? "run.cmd" : "run.sh";
  if (!fs.existsSync(path.join(runnerDir, configScript))) {
    return `Runner is not installed at '${runnerDir}'. Run 'dgrunner setup' first.`;
  }
  if (!isRunnerConfigured(runnerDir)) {
    return `Runner is installed but not configured at '${runnerDir}'. Run 'dgrunner setup' first.`;
  }
  if (!fs.existsSync(path.join(runnerDir, startScript))) {
    return `Runner start script '${startScript}' is missing from '${runnerDir}'. Re-run 'dgrunner setup'.`;
  }
  return undefined;
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
    const value: unknown = JSON.parse(content);
    return isRunnerMetadata(value) ? value : null;
  } catch {
    return null;
  }
}

function isRunnerMetadata(value: unknown): value is RunnerMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<RunnerMetadata>;
  if (
    typeof metadata.runnerDir !== "string" ||
    typeof metadata.name !== "string" ||
    !validateRunnerName(metadata.name).valid ||
    typeof metadata.url !== "string" ||
    !Array.isArray(metadata.labels) ||
    !metadata.labels.every((label) => typeof label === "string") ||
    !validateRunnerLabels(metadata.labels).valid ||
    typeof metadata.configuredAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.configuredAt)) ||
    typeof metadata.os !== "string" ||
    typeof metadata.arch !== "string" ||
    (metadata.scope !== "repo" && metadata.scope !== "org") ||
    (metadata.mode !== undefined && metadata.mode !== "native" && metadata.mode !== "docker" && metadata.mode !== "wsl") ||
    (metadata.containerName !== undefined &&
      (typeof metadata.containerName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(metadata.containerName)))
  ) return false;

  if (metadata.mode === "docker") {
    const containerName = metadata.containerName || metadata.runnerDir.replace(/^docker:/, "");
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName);
  }
  return true;
}

export async function listLocalRunnerMetadata(baseDir = DEFAULT_BASE_DIR): Promise<RunnerMetadata[]> {
  const metadataByIdentity = new Map<string, RunnerMetadata>();
  const registryDir = getRunnerRegistryDir(baseDir);
  const registryFiles = await fsPromises.readdir(registryDir).catch(() => []);

  for (const fileName of registryFiles.filter((name) => name.endsWith(".json"))) {
    try {
      const value: unknown = JSON.parse(await fsPromises.readFile(path.join(registryDir, fileName), "utf-8"));
      if (isRunnerMetadata(value)) metadataByIdentity.set(runnerMetadataIdentity(value), value);
    } catch {}
  }

  const legacyMetadata = await readLocalMetadata(baseDir);
  if (legacyMetadata && isRunnerMetadata(legacyMetadata)) {
    const identity = runnerMetadataIdentity(legacyMetadata);
    if (!metadataByIdentity.has(identity)) metadataByIdentity.set(identity, legacyMetadata);
  }

  return [...metadataByIdentity.values()];
}

export function metadataMatchesRunner(metadata: RunnerMetadata | null, runnerDir: string): boolean {
  if (!metadata) return false;
  if (metadata.mode === "docker") {
    const containerName = metadata.containerName || metadata.runnerDir.replace(/^docker:/, "");
    if (runnerDir.startsWith("docker:")) return containerName === runnerDir.slice("docker:".length);
    return normalizeRunnerPath(runnerDir) === normalizeRunnerPath(DEFAULT_RUNNER_DIR) &&
      containerName === DEFAULT_CONTAINER_NAME;
  }

  const metadataRunnerDir = metadata.runnerDir || DEFAULT_RUNNER_DIR;
  return normalizeRunnerPath(metadataRunnerDir) === normalizeRunnerPath(runnerDir);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
      encoding: "utf-8",
    });
    await fsPromises.rename(temporaryPath, filePath);
    if (process.platform !== "win32") await fsPromises.chmod(filePath, 0o600);
  } catch (error) {
    await fsPromises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function readMetadataForRunner(
  runnerDir: string,
  baseDir = DEFAULT_BASE_DIR
): Promise<RunnerMetadata | null> {
  const metadata = await listLocalRunnerMetadata(baseDir);
  const matches = metadata.filter((entry) => metadataMatchesRunner(entry, runnerDir));
  if (matches.length > 1 && normalizeRunnerPath(runnerDir) === normalizeRunnerPath(DEFAULT_RUNNER_DIR)) {
    const nativeMetadata = matches.find((entry) => entry.mode !== "docker");
    const dockerMetadata = matches.find((entry) => entry.mode === "docker");
    return isRunnerConfigured(runnerDir) ? nativeMetadata || dockerMetadata || null : dockerMetadata || nativeMetadata || null;
  }
  return matches[0] || null;
}

export async function saveLocalMetadata(meta: RunnerMetadata, baseDir = DEFAULT_BASE_DIR): Promise<void> {
  const previousMetadata = await readLocalMetadata(baseDir);
  if (previousMetadata && isRunnerMetadata(previousMetadata) && runnerMetadataIdentity(previousMetadata) !== runnerMetadataIdentity(meta)) {
    await writeJsonAtomically(getRunnerMetadataFile(previousMetadata, baseDir), previousMetadata);
  }

  await writeJsonAtomically(getRunnerMetadataFile(meta, baseDir), meta);
  await writeJsonAtomically(getRunnerConfigFile(baseDir), meta);
}

export async function removeLocalMetadata(meta: RunnerMetadata, baseDir = DEFAULT_BASE_DIR): Promise<void> {
  const unlinkIfPresent = async (filePath: string) => {
    try {
      await fsPromises.unlink(filePath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  await unlinkIfPresent(getRunnerMetadataFile(meta, baseDir));
  const legacyMetadata = await readLocalMetadata(baseDir);
  if (legacyMetadata && isRunnerMetadata(legacyMetadata) && runnerMetadataIdentity(legacyMetadata) === runnerMetadataIdentity(meta)) {
    await unlinkIfPresent(getRunnerConfigFile(baseDir));
  }
}

export async function resolveRunnerDirectory(
  selector: string | undefined,
  defaultRunnerDir = DEFAULT_RUNNER_DIR,
  baseDir = DEFAULT_BASE_DIR
): Promise<{ runnerDir?: string; error?: string }> {
  if (!selector) return { runnerDir: defaultRunnerDir };

  const normalizedSelector = selector.trim().toLowerCase();
  const matches = (await listLocalRunnerMetadata(baseDir)).filter((metadata) =>
    metadata.name.toLowerCase() === normalizedSelector ||
    metadata.containerName?.toLowerCase() === normalizedSelector ||
    normalizeRunnerPath(metadata.runnerDir) === normalizeRunnerPath(selector)
  );
  const uniqueMatches = [...new Map(matches.map((metadata) => [runnerMetadataIdentity(metadata), metadata])).values()];

  if (uniqueMatches.length === 1) return { runnerDir: uniqueMatches[0]?.runnerDir };
  if (uniqueMatches.length === 0) {
    return { error: `No configured runner named '${selector}' was found. Use 'dgrunner ps' to see active runners.` };
  }

  const selectors = uniqueMatches.map((metadata) => metadata.containerName || metadata.runnerDir);
  return {
    error: `Runner name '${selector}' is ambiguous. Select one by container name or runner directory: ${selectors.join(", ")}.`,
  };
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
  const runnerName = (options.name || `${os.hostname()}-dgrunner`).trim();
  const workDir = options.workDir || "_work";
  const url = options.url.trim();
  const urlValidation = validateGitHubUrl(url);
  if (!urlValidation.valid) return { success: false, output: urlValidation.error || "Invalid GitHub URL." };
  const tokenValidation = validateRegistrationToken(options.token);
  if (!tokenValidation.valid) return { success: false, output: tokenValidation.error || "Invalid runner token." };
  const nameValidation = validateRunnerName(runnerName);
  if (!nameValidation.valid) return { success: false, output: nameValidation.error || "Invalid runner name." };
  const labels = options.labels && options.labels.length > 0
    ? normalizeRunnerLabels(options.labels)
    : ["self-hosted", "dgrunner", process.platform === "win32" ? "windows" : "linux", process.arch];
  const labelsValidation = validateRunnerLabels(labels);
  if (!labelsValidation.valid) return { success: false, output: labelsValidation.error || "Invalid runner labels." };
  const labelsStr = labels.join(",");

  await ensureRunnerEnvironment(runnerDir);

  const args: string[] = [
    "--unattended",
    "--url", url,
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
    env: { ...process.env, ACTIONS_RUNNER_INPUT_TOKEN: options.token },
  });

  const success = result.exitCode === 0;

  if (success) {
    const scope = url.split("/").filter(Boolean).length === 4 ? "repo" : "org";
    try {
      await saveLocalMetadata({
        runnerDir,
        url,
        name: runnerName,
        labels,
        scope,
        configuredAt: new Date().toISOString(),
        os: process.platform,
        arch: process.arch,
        mode: options.mode || "native",
        distro: options.distro,
      });
    } catch (error) {
      return {
        success: false,
        output: redactSecret(
          `Runner registered with GitHub, but local metadata could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          options.token
        ),
      };
    }
  }

  return {
    success,
    output: redactSecret(`${result.stdout}\n${result.stderr}`.trim(), options.token),
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
  }
  return installLinuxRunnerService(runnerDir);
}

/**
 * Starts the runner persistent service or background process.
 */
export async function startService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  const localMeta = await readMetadataForRunner(runnerDir);
  if (localMeta?.mode === "docker") {
    const res = await startDockerContainer(localMeta.containerName, {
      name: localMeta.name,
      url: localMeta.url,
    });
    return {
      success: res.success,
      message: res.success
        ? `Docker runner container '${localMeta.containerName}' started.`
        : res.output,
    };
  }

  const currentStatus = await getRunnerStatus(runnerDir);
  if (currentStatus.serviceRunning) {
    return {
      success: true,
      message: `Runner is already running${currentStatus.activePid ? ` with PID ${currentStatus.activePid}` : ""}.`,
    };
  }

  const readinessError = getRunnerStartError(runnerDir);
  if (readinessError) return { success: false, message: readinessError };

  if (process.platform === "win32") {
    // Launch run.cmd in detached background mode if not already running
    await ensureDir(DEFAULT_BASE_DIR);
    const pidFile = getRunnerPidFile(runnerDir);

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
    return startLinuxRunnerService(runnerDir);
  }
}

/**
 * Stops the runner persistent service or background process.
 */
export async function stopService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  const localMeta = await readMetadataForRunner(runnerDir);
  if (localMeta?.mode === "docker") {
    const res = await stopDockerRunner(localMeta.containerName, {
      name: localMeta.name,
      url: localMeta.url,
    });
    return {
      success: res.success,
      message: res.success
        ? `Docker runner container '${localMeta.containerName}' stopped.`
        : res.output,
    };
  }

  if (process.platform === "win32") {
    const pidFile = getRunnerPidFile(runnerDir);
    const pids = new Set(await findRunnerListenerPids(runnerDir));
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && await verifyWindowsRunnerProcess(pid, runnerDir)) {
        pids.add(pid);
      }
    }

    for (const pid of pids) {
      const stopped = await execCommand("taskkill.exe", ["/pid", String(pid), "/t", "/f"]);
      if (stopped.exitCode !== 0 && await verifyWindowsRunnerProcess(pid, runnerDir)) {
        return { success: false, message: stopped.stderr || stopped.stdout || `Failed to stop runner process ${pid}.` };
      }
    }

    try {
      fs.unlinkSync(pidFile);
    } catch {}

    return { success: true, message: pids.size ? "Runner process stopped." : "Runner is not running." };
  } else {
    const serviceInfo = await readLinuxServiceUnit(runnerDir);
    if (serviceInfo.error) return { success: false, message: serviceInfo.error };
    const serviceInstalled = Boolean(serviceInfo.unitName);
    if (serviceInstalled) {
      const stopped = await stopLinuxRunnerService(runnerDir);
      if (!stopped.success) return stopped;
    }

    const pids = await findRunnerListenerPids(runnerDir);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGINT");
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          return { success: false, message: `Failed to stop runner process ${pid}: ${error?.message || String(error)}` };
        }
      }
    }

    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const remainingPids = await findRunnerListenerPids(runnerDir);
      for (const pid of remainingPids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error: any) {
          if (error?.code !== "ESRCH") {
            return { success: false, message: `Failed to stop runner process ${pid}: ${error?.message || String(error)}` };
          }
        }
      }
      if ((await findRunnerListenerPids(runnerDir)).length > 0) {
        return { success: false, message: "Runner process is still running after stop signals were sent." };
      }
    }

    return {
      success: true,
      message: serviceInstalled ? "Runner systemd service stopped." : pids.length ? "Runner process stopped." : "Runner is not running.",
    };
  }
}

/**
 * Restarts a native or Docker runner and reports stop failures before starting it again.
 */
export async function restartService(runnerDir = DEFAULT_RUNNER_DIR): Promise<{ success: boolean; message: string }> {
  const localMeta = await readMetadataForRunner(runnerDir);
  if (localMeta?.mode === "docker") {
    const containerName = localMeta.containerName || DEFAULT_CONTAINER_NAME;
    const result = await restartDockerRunner(containerName, {
      name: localMeta.name,
      url: localMeta.url,
    });
    return {
      success: result.success,
      message: result.success ? `Docker runner container '${containerName}' restarted.` : result.output,
    };
  }

  const stopped = await stopService(runnerDir);
  if (!stopped.success) return stopped;

  const started = await startService(runnerDir);
  if (!started.success) return started;

  return { success: true, message: "Runner restarted successfully." };
}

/**
 * Unregisters the runner and removes configuration.
 */
export async function removeRunner(
  runnerDir = DEFAULT_RUNNER_DIR,
  token: string
): Promise<{ success: boolean; output: string }> {
  const tokenValidation = validateRegistrationToken(token);
  if (!tokenValidation.valid) return { success: false, output: tokenValidation.error || "Invalid runner removal token." };

  const localMeta = await readMetadataForRunner(runnerDir);
  if (localMeta?.mode === "docker") {
    const res = await removeDockerRunner(token, localMeta.containerName, true, {
      name: localMeta.name,
      url: localMeta.url,
    });
    if (res.success) {
      try {
        await removeLocalMetadata(localMeta);
      } catch (error) {
        return {
          success: false,
          output: redactSecret(
            `Runner was removed from Docker and GitHub, but local metadata could not be removed: ${error instanceof Error ? error.message : String(error)}`,
            token
          ),
        };
      }
    }
    return res;
  }

  // Stop and uninstall services before unregistering to avoid leaving a live runner behind.
  const stopped = await stopService(runnerDir);
  if (!stopped.success) return { success: false, output: stopped.message };

  if (process.platform === "linux") {
    const uninstalled = await uninstallLinuxRunnerService(runnerDir);
    if (!uninstalled.success) return { success: false, output: uninstalled.message };
  }

  const script = process.platform === "win32" ? "config.cmd" : "./config.sh";
  const cmd = process.platform === "win32" ? path.join(runnerDir, script) : script;

  const result = await execCommand(cmd, ["remove"], {
    cwd: runnerDir,
    timeoutMs: 30000,
    env: { ...process.env, ACTIONS_RUNNER_INPUT_TOKEN: token },
  });

  if (result.exitCode === 0 && localMeta) {
    try {
      await removeLocalMetadata(localMeta);
    } catch (error) {
      return {
        success: false,
        output: redactSecret(
          `Runner was removed from GitHub, but local metadata could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          token
        ),
      };
    }
  }

  return {
    success: result.exitCode === 0,
    output: redactSecret(`${result.stdout}\n${result.stderr}`.trim(), token),
  };
}

/**
 * Gets comprehensive status of the runner.
 */
export async function getRunnerStatus(runnerDir = DEFAULT_RUNNER_DIR): Promise<RunnerStatusInfo> {
  const localMeta = await readMetadataForRunner(runnerDir);
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
  const listenerPids = await findRunnerListenerPids(runnerDir);
  if (listenerPids.length > 0) {
    serviceRunning = true;
    activePid = listenerPids[0];
  }

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
  } else if (process.platform === "linux") {
    if (!serviceRunning) {
      serviceRunning = await getLinuxRunnerServiceStatus(runnerDir);
    }
  }

  return {
    installed,
    configured,
    runnerName: officialConfig?.runnerName || localMeta?.name,
    targetUrl: officialConfig?.serverUrl || localMeta?.url,
    labels: localMeta?.labels,
    serviceInstalled: process.platform === "linux"
      ? (await readLinuxServiceUnit(runnerDir)).installed
      : false,
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
      DGRUNNER_EXECUTABLE: path.resolve(runnerDir, "bin", "Runner.Listener.exe"),
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

function parseDockerMemoryMb(memoryUsage: string): number | undefined {
  const currentUsage = memoryUsage.split("/", 1)[0]?.trim();
  const match = currentUsage?.match(/^(\d+(?:\.\d+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match?.[1] || !match[2]) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;

  const bytesPerUnit: Record<string, number> = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_024 ** 2,
    gb: 1_000_000_000,
    gib: 1_024 ** 3,
    tb: 1_000_000_000_000,
    tib: 1_024 ** 4,
  };
  const bytes = value * bytesPerUnit[match[2].toLowerCase()];
  return Number.isFinite(bytes) ? Math.round(bytes / (1_024 ** 2)) : undefined;
}

async function readLinuxProcessMemoryMb(pid: number): Promise<number | undefined> {
  try {
    const status = await fsPromises.readFile(`/proc/${pid}/status`, "utf-8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (!match?.[1]) return undefined;
    return Math.round(Number(match[1]) / 1_024);
  } catch {
    return undefined;
  }
}

/**
 * Runs the runner attached in the foreground, streaming stdout/stderr in real time.
 */
export async function runForeground(runnerDir = DEFAULT_RUNNER_DIR): Promise<number> {
  const localMeta = await readMetadataForRunner(runnerDir);
  if (localMeta?.mode === "docker") {
    const container = localMeta.containerName || "upstand-dgrunner-linux";
    // Check if container is running; if not, restart it
    const status = await getDockerRunnerStatus(container);
    if (!status.running) {
      const started = await startDockerContainer(container, {
        name: localMeta.name,
        url: localMeta.url,
      });
      if (!started.success) {
        console.error(started.output);
        return 1;
      }
    }
    return tailDockerRunnerLogs(container, true);
  }

  const readinessError = getRunnerStartError(runnerDir);
  if (readinessError) {
    console.error(readinessError);
    return 1;
  }

  const runnerStatus = await getRunnerStatus(runnerDir);
  if (runnerStatus.serviceRunning) {
    console.error("The runner is already running in the background. Stop it with 'dgrunner stop' before attaching.");
    console.error("Use 'dgrunner logs --follow' to view the active runner logs.");
    return 1;
  }

  await ensureRunnerEnvironment(runnerDir);

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
      execFile = path.join(runnerDir, "run.cmd");
      execArgs = [];
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

    child.on("close", (code, signal) => {
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", () => {
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      resolve(1);
    });
  });
}

async function findRunnerListenerPids(runnerDir: string): Promise<number[]> {
  if (process.platform === "win32") {
    const result = await execCommand("powershell.exe", ["-NoProfile", "-Command", [
      "$expected = [IO.Path]::GetFullPath($env:DGRUNNER_EXECUTABLE)",
      "$runnerProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'Runner.Listener.exe' -and $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expected) })",
      "if ($runnerProcesses.Count -gt 0) { [Console]::Write(($runnerProcesses.ProcessId -join ',')) }",
    ].join("; ")], {
      env: {
        ...process.env,
        DGRUNNER_EXECUTABLE: path.resolve(runnerDir, "bin", "Runner.Listener.exe"),
      },
    });
    if (result.exitCode !== 0) return [];
    return [...new Set(result.stdout.split(/[\s,;]+/).map((value) => Number.parseInt(value, 10)))]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  if (process.platform === "linux") {
    const runnerDirAbsolute = path.resolve(runnerDir);
    const runnerExecutable = path.join(runnerDirAbsolute, "bin", "Runner.Listener");
    const expectedExecutable = await fsPromises.realpath(runnerExecutable).catch(() => runnerExecutable);
    const pids = new Set<number>();
    const result = await execCommand("pgrep", ["-af", "Runner.Listener"]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      // pgrep is quick and continues to list processes when /proc/<pid>/exe is
      // restricted. Scope relative invocations by checking each process cwd.
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match || !match[1] || !match[2]) continue;
        const pid = Number.parseInt(match[1], 10);
        const command = match[2];
        try {
          const executable = (await fsPromises.readlink(path.join("/proc", String(pid), "exe"))).replace(/ \(deleted\)$/, "");
          if (path.resolve(executable) === expectedExecutable) {
            pids.add(pid);
            continue;
          }
        } catch {}
        try {
          const cwd = await fsPromises.readlink(path.join("/proc", String(pid), "cwd"));
          const argv0 = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
          const executableArg = argv0?.[1] || argv0?.[2] || argv0?.[3];
          if (executableArg) {
            const lexicalArg = path.resolve(cwd, executableArg);
            const resolvedArg = await fsPromises.realpath(lexicalArg).catch(() => lexicalArg);
            if (resolvedArg === expectedExecutable) pids.add(pid);
          }
        } catch {}
      }
      return [...pids];
    }

    // If procps is unavailable, retain a /proc fallback for standard Linux hosts.
    if (!result.stderr.trim()) return [];
    const procEntries = await fsPromises.readdir("/proc").catch(() => []);
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const executable = (await fsPromises.readlink(path.join("/proc", entry, "exe"))).replace(/ \(deleted\)$/, "");
        if (path.resolve(executable) === expectedExecutable) pids.add(Number(entry));
      } catch {}
    }
    return [...pids];
  }

  if (process.platform === "darwin") {
    const candidates = await execCommand("pgrep", ["-x", "Runner.Listener"]);
    if (candidates.exitCode !== 0 || !candidates.stdout.trim()) return [];
    const expectedExecutable = await fsPromises.realpath(path.resolve(runnerDir, "bin", "Runner.Listener"))
      .catch(() => path.resolve(runnerDir, "bin", "Runner.Listener"));
    const pids = await Promise.all(candidates.stdout.split(/\s+/).flatMap((value) => {
      const pid = Number.parseInt(value, 10);
      return Number.isInteger(pid) && pid > 0 ? [pid] : [];
    }).map(async (pid) => {
      const executable = await execCommand("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeoutMs: 5000 });
      if (executable.exitCode !== 0) return undefined;
      const paths = executable.stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
      const matches = paths.some((candidate) => path.resolve(candidate) === expectedExecutable);
      return matches ? pid : undefined;
    }));
    return pids.filter((pid): pid is number => pid !== undefined);
  }

  // Avoid treating an arbitrary process argument as proof of runner ownership
  // on platforms where executable identity cannot be verified safely.
  return [];
}

/**
 * Lists active runner processes on the host and Docker containers.
 */
export async function listRunnerProcesses(runnerDir = DEFAULT_RUNNER_DIR, baseDir = DEFAULT_BASE_DIR): Promise<ActiveProcessInfo[]> {
  const officialConfig = await readOfficialRunnerConfig(runnerDir);
  const localMeta = await readMetadataForRunner(runnerDir, baseDir);
  const runnerName = officialConfig?.runnerName || localMeta?.name || "dgrunner";
  const targetUrl = officialConfig?.serverUrl || localMeta?.url || "Unknown";
  const allMetadata = await listLocalRunnerMetadata(baseDir);

  const results: ActiveProcessInfo[] = [];

  // 1. Check Docker runner containers
  try {
    const containersById = new Map<string, { id: string; name: string; status: string }>();
    const dockerPsFilters = [
      ["--filter", `label=${DGRUNNER_MANAGED_LABEL}=true`],
      ["--filter", "name=upstand-dgrunner"],
    ];
    const legacyContainerNames = new Set([
      DEFAULT_CONTAINER_NAME,
      ...allMetadata.filter((metadata) => metadata.mode === "docker").map((metadata) => metadata.containerName || metadata.runnerDir.replace(/^docker:/, "")),
    ]);
    for (const [filterIndex, filter] of dockerPsFilters.entries()) {
      const dockerPs = await execCommand("docker", [
        "ps",
        ...filter,
        "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}",
      ]);
      if (dockerPs.exitCode !== 0 || !dockerPs.stdout.trim()) continue;
      const lines = dockerPs.stdout.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const [id, name, status] = line.split("\t");
        if (filterIndex === 1 && name && !legacyContainerNames.has(name)) continue;
        if (id && name) {
          containersById.set(id, { id, name, status: status || "Up (healthy)" });
        }
      }
    }

    const containers = [...containersById.values()];
    if (containers.length > 0) {
      const memoryByContainer = new Map<string, number>();
      const dockerStats = await execCommand("docker", [
          "stats",
          "--no-stream",
          "--format",
          "{{.ID}}\t{{.MemUsage}}",
          ...containers.map((container) => container.id),
      ], { timeoutMs: 5_000 }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      if (dockerStats.exitCode === 0 && dockerStats.stdout.trim()) {
        for (const line of dockerStats.stdout.split(/\r?\n/).filter(Boolean)) {
          const [statsId, memoryUsage] = line.split("\t");
          if (!statsId || !memoryUsage) continue;
          const container = containers.find(({ id, name }) => {
            const normalizedStatsId = statsId.toLowerCase();
            const normalizedId = id.toLowerCase();
            return normalizedId.startsWith(normalizedStatsId) ||
              normalizedStatsId.startsWith(normalizedId) ||
              name.toLowerCase() === normalizedStatsId;
          });
          const memoryMb = parseDockerMemoryMb(memoryUsage);
          if (container && memoryMb !== undefined) memoryByContainer.set(container.id, memoryMb);
        }
      }

      const metadataByContainer = new Map(await Promise.all(containers.map(async (container) => [
        container.name,
        await readMetadataForRunner(`docker:${container.name}`, baseDir),
      ] as const)));
      for (const container of containers) {
        const containerMetadata = metadataByContainer.get(container.name);
        results.push({
          pid: container.id.slice(0, 12),
          name: `${container.name} (docker)`,
          runnerName: containerMetadata?.name || container.name,
          targetUrl: containerMetadata?.url || "Unknown",
          memoryMb: memoryByContainer.get(container.id),
          status: container.status,
        });
      }
    }
  } catch {}

  // 2. Check Host processes
  const nativeRunners: Array<{ runnerDir: string; metadata: RunnerMetadata | undefined }> = allMetadata
    .filter((metadata) => metadata.mode !== "docker")
    .map((metadata) => ({ runnerDir: metadata.runnerDir, metadata }));
  if (!nativeRunners.some((runner) => normalizeRunnerPath(runner.runnerDir) === normalizeRunnerPath(runnerDir))) {
    nativeRunners.push({
      runnerDir,
      metadata: localMeta?.mode === "docker" ? undefined : localMeta || undefined,
    });
  }
  const nativeProcesses = (await Promise.all(nativeRunners.map(async (runner) => ({
    ...runner,
    pids: await findRunnerListenerPids(runner.runnerDir),
  })))).flatMap((runner) => runner.pids.map((pid) => ({ ...runner, pid })));

  const windowsMemoryByPid = new Map<number, number>();
  if (process.platform === "win32" && nativeProcesses.length > 0) {
    const managedPids = [...new Set(nativeProcesses.map(({ pid }) => pid))];
    const result = await execCommand("powershell.exe", ["-NoProfile", "-Command", [
      "$managedIds = @($env:DGRUNNER_MANAGED_PIDS -split ',' | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ })",
      "$processes = @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Where-Object { $managedIds -contains $_.Id } | Select-Object Id, WorkingSet64)",
      "if ($processes.Count -gt 0) { $processes | ConvertTo-Json -Compress }",
    ].join("; ")], {
      env: { ...process.env, DGRUNNER_MANAGED_PIDS: managedPids.join(",") },
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const parsed: unknown = JSON.parse(result.stdout);
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        for (const processInfo of processes) {
          if (processInfo && typeof processInfo.Id === "number" && typeof processInfo.WorkingSet64 === "number") {
            windowsMemoryByPid.set(processInfo.Id, Math.round(processInfo.WorkingSet64 / (1024 * 1024)));
          }
        }
      } catch {}
    }
  }

  const linuxMemoryByPid = new Map<number, number | undefined>();
  if (process.platform === "linux") {
    const memory = await Promise.all(nativeProcesses.map(async ({ pid }) => [
      pid,
      await readLinuxProcessMemoryMb(pid),
    ] as const));
    for (const [pid, memoryMb] of memory) linuxMemoryByPid.set(pid, memoryMb);
  }

  for (const runnerProcess of nativeProcesses) {
    const config = await readOfficialRunnerConfig(runnerProcess.runnerDir);
    results.push({
      pid: runnerProcess.pid,
      name: "Runner.Listener",
      runnerName: config?.runnerName || runnerProcess.metadata?.name || "dgrunner",
      targetUrl: config?.serverUrl || runnerProcess.metadata?.url || "Unknown",
      memoryMb: process.platform === "win32"
        ? windowsMemoryByPid.get(runnerProcess.pid)
        : linuxMemoryByPid.get(runnerProcess.pid),
      status: "Listening",
    });
  }

  return results;
}

/**
 * Follows/tails runner log output.
 */
async function readLastLines(filePath: string, count: number): Promise<string[]> {
  const lines: string[] = [];
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    lines.push(line);
    if (lines.length > count) lines.shift();
  }
  return lines;
}

export interface RunnerLogTailState {
  decoder: StringDecoder;
  pendingText: string;
}

export function writeRunnerLogChunk(label: string, chunk: Uint8Array, state: RunnerLogTailState): void {
  const text = state.pendingText + state.decoder.write(chunk);
  const lines = text.split(/\r?\n/);
  state.pendingText = lines.pop() || "";
  for (const line of lines) process.stdout.write(`[${label}] ${line}\n`);
}

export function flushRunnerLogTailState(label: string, state: RunnerLogTailState): void {
  const pendingText = state.pendingText + state.decoder.end();
  state.pendingText = "";
  if (pendingText) process.stdout.write(`[${label}] ${pendingText}\n`);
}

export async function tailRunnerLogs(options: {
  follow?: boolean;
  lines?: number;
  baseDir?: string;
  runnerDir?: string;
} = {}): Promise<void> {
  const runnerDir = options.runnerDir || DEFAULT_RUNNER_DIR;
  const linesCount = Math.max(1, Math.min(10000, Math.floor(options.lines || 50)));
  const localMeta = await readMetadataForRunner(runnerDir, options.baseDir);
  if (localMeta?.mode === "docker") {
    await tailDockerRunnerLogs(localMeta.containerName, options.follow, linesCount);
    return;
  }

  if (process.platform === "linux") {
    const service = await getValidatedLinuxServiceUnit(runnerDir);
    if (service.error) {
      console.error(service.error);
      return;
    }
    if (!service.unitName) {
      console.log(`No installed runner service found in ${runnerDir}`);
      return;
    }
    const args = ["journalctl", "--no-pager", "--unit", service.unitName, "--lines", String(linesCount)];
    if (options.follow) args.push("--follow");
    const code = await execInteractive("sudo", args);
    if (code !== 0) console.error(`Could not read runner service logs (exit code ${code}).`);
    return;
  }

  const baseDir = options.baseDir || DEFAULT_BASE_DIR;
  const logFiles = [
    { label: "stdout", path: path.join(baseDir, "runner-stdout.log") },
    { label: "stderr", path: path.join(baseDir, "runner-stderr.log") },
  ].filter(({ path: filePath }) => fs.existsSync(filePath));

  if (logFiles.length === 0) {
    console.log(`No runner log files found in ${baseDir}`);
    return;
  }

  for (const log of logFiles) {
    for (const line of await readLastLines(log.path, linesCount)) {
      console.log(`[${log.label}] ${line}`);
    }
  }

  if (options.follow) {
    console.log("\n--- Following live logs (Press Ctrl+C to detach) ---");
    const logStates = new Map<string, { size: number; decoder: StringDecoder; pendingText: string }>();
    for (const log of logFiles) {
      logStates.set(log.path, {
        size: (await fsPromises.stat(log.path)).size,
        decoder: new StringDecoder("utf8"),
        pendingText: "",
      });
    }
    let polling = false;
    let detached = false;
    let pollPromise = Promise.resolve();

    const poll = async () => {
      if (polling || detached) return;
      polling = true;
      try {
        for (const log of logFiles) {
          if (detached) break;
          const stats = await fsPromises.stat(log.path);
          const state = logStates.get(log.path)!;
          if (stats.size < state.size) {
            flushRunnerLogTailState(log.label, state);
            state.size = 0;
            state.decoder = new StringDecoder("utf8");
          }
          if (stats.size > state.size) {
            const stream = fs.createReadStream(log.path, { start: state.size, end: stats.size - 1 });
            for await (const chunk of stream) {
              writeRunnerLogChunk(log.label, chunk, state);
            }
            state.size = stats.size;
          }
        }
      } catch {} finally {
        polling = false;
      }
    };

    const interval = setInterval(() => {
      if (!polling && !detached) pollPromise = poll();
    }, 1000);

    await new Promise<void>((resolve) => {
      const detach = () => {
        detached = true;
        clearInterval(interval);
        process.off("SIGINT", detach);
        void pollPromise.finally(() => {
          for (const log of logFiles) {
            const state = logStates.get(log.path)!;
            flushRunnerLogTailState(log.label, state);
          }
          console.log("\nDetached from runner logs.");
          resolve();
        });
      };
      process.once("SIGINT", detach);
    });
  }
}
