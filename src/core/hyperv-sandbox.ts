import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_BASE_DIR } from "../config/constants.js";
import { normalizeRunnerLabels, validateGitHubUrl, validateRunnerLabels, validateRunnerName } from "./security.js";
import { execCommand } from "../utils/exec.js";
import { redactSecret } from "../utils/logger.js";

const HYPERV_PS = "powershell.exe";
const SANDBOX_ROOT = path.join(DEFAULT_BASE_DIR, "sandbox-vms");
const MAX_RETRIES = 3;

export interface HyperVSandboxOptions {
  url: string;
  name: string;
  labels: string[];
  templatePath: string;
  switchName: string;
  sshUser: string;
  sshKeyPath: string;
  runnerDirectory: string;
  memoryGiB: number;
  processors: number;
  generation: 1 | 2;
  ipTimeoutMs?: number;
  signal?: AbortSignal;
}

interface HyperVVm {
  name: string;
  diskPath: string;
  knownHostsPath: string;
}

export interface HyperVSandboxValidation {
  valid: boolean;
  error?: string;
  normalized?: HyperVSandboxOptions;
}

export function validateHyperVSandboxOptions(options: HyperVSandboxOptions): HyperVSandboxValidation {
  if (process.platform !== "win32") {
    return { valid: false, error: "Hyper-V sandbox runners are supported only on Windows hosts." };
  }

  const urlValidation = validateGitHubUrl(options.url);
  if (!urlValidation.valid || urlValidation.scope !== "repo") {
    return { valid: false, error: urlValidation.error || "Hyper-V sandbox runners require a repository URL." };
  }

  const parsedUrl = new URL(options.url);
  if (parsedUrl.hostname !== "github.com") {
    return { valid: false, error: "Hyper-V sandbox runners currently support GitHub.com repository URLs." };
  }

  const nameValidation = validateRunnerName(options.name);
  if (!nameValidation.valid) return { valid: false, error: nameValidation.error };

  const labels = normalizeRunnerLabels(options.labels);
  const labelsValidation = validateRunnerLabels(labels);
  if (!labelsValidation.valid) return { valid: false, error: labelsValidation.error };
  if (!labels.some((label) => label.toLowerCase() === "self-hosted") ||
      !labels.some((label) => label.toLowerCase() === "linux") ||
      !labels.some((label) => label.toLowerCase() === "x64")) {
    return { valid: false, error: "Labels must include self-hosted, linux, and x64." };
  }

  if (!options.templatePath || !path.isAbsolute(options.templatePath) || !/\.vhdx?$/i.test(options.templatePath)) {
    return { valid: false, error: "Provide an absolute path to a bootable Hyper-V .vhd or .vhdx template." };
  }
  if (!options.switchName?.trim() || /[\u0000-\u001f\u007f]/.test(options.switchName)) {
    return { valid: false, error: "A valid Hyper-V virtual switch name is required." };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(options.sshUser)) {
    return { valid: false, error: "SSH user must be a simple Linux account name." };
  }
  if (!options.sshKeyPath || !path.isAbsolute(options.sshKeyPath)) {
    return { valid: false, error: "Provide an absolute path to the SSH private key for the guest template." };
  }
  if (!options.runnerDirectory || !options.runnerDirectory.startsWith("/")) {
    return { valid: false, error: "Runner directory must be an absolute Linux path inside the guest template." };
  }
  if (!Number.isInteger(options.memoryGiB) || options.memoryGiB < 2 || options.memoryGiB > 128) {
    return { valid: false, error: "VM memory must be a whole number between 2 and 128 GiB." };
  }
  if (!Number.isInteger(options.processors) || options.processors < 1 || options.processors > 64) {
    return { valid: false, error: "VM processors must be a whole number between 1 and 64." };
  }

  return {
    valid: true,
    normalized: {
      ...options,
      url: options.url.trim().replace(/\/$/, ""),
      name: options.name.trim(),
      labels,
      templatePath: path.resolve(options.templatePath),
      switchName: options.switchName.trim(),
      sshKeyPath: path.resolve(options.sshKeyPath),
      runnerDirectory: options.runnerDirectory.trim(),
    },
  };
}

export async function runHyperVSandbox(options: HyperVSandboxOptions): Promise<void> {
  const validation = validateHyperVSandboxOptions(options);
  if (!validation.valid || !validation.normalized) throw new Error(validation.error || "Invalid Hyper-V sandbox configuration.");
  const config = validation.normalized;
  const templatePath = await verifyInputFile(config.templatePath, "Hyper-V template");
  const sshKeyPath = await verifyInputFile(config.sshKeyPath, "SSH private key");
  await fs.mkdir(SANDBOX_ROOT, { recursive: true, mode: 0o700 });

  await verifyHyperVHost(config.switchName);
  await verifyGhAuthentication(new URL(config.url).hostname);
  await verifyPrivateRepository(config.url, new URL(config.url).hostname);

  console.log(`Hyper-V sandbox runner ready for ${config.url}.`);
  console.log(`Each job runs in a fresh VM from ${templatePath}; Ctrl+C stops the supervisor.`);
  console.log("The runner uses Docker inside the guest VM. The Windows Docker socket is not mounted.");

  let retries = 0;
  while (!config.signal?.aborted) {
    let vm: HyperVVm | undefined;
    let jitConfig = "";
    try {
      const id = randomUUID().replace(/-/g, "");
      const vmName = `dgrunner-job-${id}`;
      const vmDir = path.join(SANDBOX_ROOT, vmName);
      await fs.mkdir(vmDir, { mode: 0o700 });
      vm = {
        name: vmName,
        diskPath: path.join(vmDir, `${vmName}.vhdx`),
        knownHostsPath: path.join(vmDir, "known_hosts"),
      };

      await createAndStartVm(config, vm, templatePath);
      const ipAddress = await waitForVmIp(vm.name, config.ipTimeoutMs ?? 300_000, config.signal);
      if (!ipAddress) throw new Error(`Hyper-V guest '${vm.name}' did not report a private IPv4 address in time.`);

      const runnerName = makeJobRunnerName(config.name, id);
      jitConfig = await createJitConfig(config.url, runnerName, config.labels, new URL(config.url).hostname);
      console.log(`Runner VM ${vm.name} is online at ${ipAddress}; waiting for one GitHub Actions job.`);
      const runResult = await runGuestJob(config, vm, ipAddress, sshKeyPath, jitConfig);
      jitConfig = "";
      if (config.signal?.aborted) break;

      retries = 0;
      if (runResult.stdout) console.log(runResult.stdout);
      if (runResult.stderr) console.error(runResult.stderr);
      if (runResult.exitCode === 0) {
        console.log(`Job VM ${vm.name} finished. Removing it before the next job.`);
      } else {
        console.warn(`Job VM ${vm.name} exited with code ${runResult.exitCode}; discarding it.`);
      }
    } catch (error) {
      if (config.signal?.aborted) break;
      retries += 1;
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      jitConfig = "";
      if (vm) await removeVm(vm, templatePath);
    }

    if (retries >= MAX_RETRIES) {
      throw new Error(`The sandbox runner failed ${MAX_RETRIES} times consecutively; stopping to avoid an endless provisioning loop.`);
    }
    if (!config.signal?.aborted) await delay(retries ? 10_000 : 1_000, config.signal);
  }
}

async function verifyInputFile(filePath: string, description: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.lstat(absolutePath).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${description} must be an existing regular file: ${absolutePath}`);
  await fs.access(absolutePath);
  return absolutePath;
}

async function verifyHyperVHost(switchName: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$cfg = $json | ConvertFrom-Json
$switch = Get-VMSwitch -Name $cfg.switchName -ErrorAction Stop | Where-Object { $_.Name -ceq $cfg.switchName }
if (-not $switch) { throw 'The requested Hyper-V virtual switch was not found by exact name.' }
Write-Output 'ready'
`;
  const result = await execCommand(HYPERV_PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: encodePowerShellJson({ switchName }),
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Hyper-V is unavailable or switch '${switchName}' cannot be used. Check Hyper-V access and the switch name. ${result.stderr || result.stdout}`.trim());
  }
}

async function verifyGhAuthentication(hostname: string): Promise<void> {
  const result = await execCommand("gh", ["auth", "status", "--hostname", hostname], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(`GitHub CLI is not authenticated for ${hostname}. Run 'gh auth login --hostname ${hostname}' with repository runner administration permission.`);
  }
}

async function verifyPrivateRepository(url: string, hostname: string): Promise<void> {
  const result = await execCommand("gh", [
    "api", "--hostname", hostname,
    "--jq", ".private",
    repositoryApiPath(url),
  ], { timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Could not verify repository visibility. Check access to ${url} and the GitHub CLI permissions. ${result.stderr}`.trim());
  }
  if (result.stdout.trim() !== "true") {
    throw new Error("Hyper-V sandbox runners only accept private GitHub repositories. Public repository workflows should use GitHub-hosted runners.");
  }
}

async function createJitConfig(url: string, runnerName: string, labels: string[], hostname: string): Promise<string> {
  const request = {
    name: runnerName,
    runner_group_id: 1,
    labels,
    work_folder: "_work",
  };
  const apiPath = `${repositoryApiPath(url)}/actions/runners/generate-jitconfig`;
  const result = await execCommand("gh", [
    "api", "--hostname", hostname,
    "--method", "POST",
    "--input", "-",
    "--jq", ".encoded_jit_config",
    apiPath,
  ], { input: JSON.stringify(request), timeoutMs: 20_000 });
  const jitConfig = result.stdout.trim();
  if (result.exitCode !== 0 || !isEncodedJitConfig(jitConfig)) {
    const detail = result.exitCode !== 0
      ? result.stderr || "GitHub CLI request failed."
      : "GitHub returned an invalid just-in-time runner configuration.";
    throw new Error(`Could not create an ephemeral GitHub runner. The account must be a repository administrator with runner-management permission. ${detail}`.trim());
  }
  return jitConfig;
}

function repositoryApiPath(url: string): string {
  const [owner, rawRepository] = new URL(url).pathname.split("/").filter(Boolean);
  const repository = rawRepository?.replace(/\.git$/i, "");
  if (!owner || !repository) throw new Error("Could not determine the GitHub repository owner and name.");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function encodePowerShellJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function isEncodedJitConfig(value: string): boolean {
  return value.length >= 16 && value.length <= 64 * 1024 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function makeJobRunnerName(prefix: string, id: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 31).replace(/-+$/, "");
  return `${safePrefix || "dgrunner"}-${id}`;
}

async function createAndStartVm(config: HyperVSandboxOptions, vm: HyperVVm, templatePath: string): Promise<void> {
  const payload = {
    name: vm.name,
    diskPath: vm.diskPath,
    templatePath,
    switchName: config.switchName,
    memoryBytes: config.memoryGiB * 1024 * 1024 * 1024,
    processors: config.processors,
    generation: config.generation,
  };
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$cfg = $json | ConvertFrom-Json
if (Get-VM -Name $cfg.name -ErrorAction SilentlyContinue) { throw 'Refusing to replace an existing VM.' }
if (-not (Test-Path -LiteralPath $cfg.templatePath -PathType Leaf)) { throw 'Template VHD was not found.' }
if (Test-Path -LiteralPath $cfg.diskPath) { throw 'Refusing to replace an existing sandbox disk.' }
New-VHD -Path $cfg.diskPath -ParentPath $cfg.templatePath -Differencing -ErrorAction Stop | Out-Null
try {
  New-VM -Name $cfg.name -Generation ([int]$cfg.generation) -MemoryStartupBytes ([long]$cfg.memoryBytes) -VHDPath $cfg.diskPath -SwitchName $cfg.switchName -ErrorAction Stop | Out-Null
  Set-VMProcessor -VMName $cfg.name -Count ([int]$cfg.processors) -ErrorAction Stop
  Set-VM -Name $cfg.name -AutomaticCheckpointsEnabled $false -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -Notes ('Managed by dgrunner ephemeral sandbox: ' + $cfg.diskPath) -ErrorAction Stop
  Start-VM -Name $cfg.name -ErrorAction Stop | Out-Null
  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
} catch {
  $created = Get-VM -Name $cfg.name -ErrorAction SilentlyContinue
  $diskOwned = $false
  if (Test-Path -LiteralPath $cfg.diskPath -PathType Leaf) {
    try {
      $vhd = Get-VHD -Path $cfg.diskPath -ErrorAction Stop
      $diskOwned = $vhd.VhdType -eq 'Differencing' -and [IO.Path]::GetFullPath($vhd.ParentPath) -eq [IO.Path]::GetFullPath($cfg.templatePath)
    } catch { }
  }
  if ($created -and $diskOwned -and $cfg.name -match '^dgrunner-job-[a-f0-9]{32}$') {
    $drives = @(Get-VMHardDiskDrive -VMName $cfg.name -ErrorAction SilentlyContinue)
    if ($drives.Count -eq 1 -and [IO.Path]::GetFullPath($drives[0].Path) -eq [IO.Path]::GetFullPath($cfg.diskPath)) {
      if ($created.State -eq 'Running') { Stop-VM -Name $cfg.name -TurnOff -Force -ErrorAction SilentlyContinue }
      Remove-VM -Name $cfg.name -Force -ErrorAction SilentlyContinue
      $created = Get-VM -Name $cfg.name -ErrorAction SilentlyContinue
    }
  }
  if (-not $created -and $diskOwned) { Remove-Item -LiteralPath $cfg.diskPath -Force -ErrorAction SilentlyContinue }
  throw
}
`;
  const result = await execCommand(HYPERV_PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: encodePowerShellJson(payload),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`Could not provision Hyper-V sandbox VM '${vm.name}'. ${result.stderr || result.stdout}`.trim());
}

async function waitForVmIp(vmName: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$cfg = $json | ConvertFrom-Json
$ips = @(Get-VMNetworkAdapter -VMName $cfg.name -ErrorAction Stop | ForEach-Object { $_.IPAddresses } | Where-Object { $_ -match '^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$' } | Select-Object -Unique)
ConvertTo-Json -InputObject $ips -Compress
`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const result = await execCommand(HYPERV_PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      input: encodePowerShellJson({ name: vmName }),
      timeoutMs: 10_000,
      signal,
    });
    if (result.exitCode === 0) {
      try {
        const raw = JSON.parse(result.stdout) as string | string[] | null;
        const ips = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const candidate = ips.find((ip) => typeof ip === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip));
        if (candidate) return candidate;
      } catch {}
    }
    await delay(5_000, signal);
  }
  return undefined;
}

async function runGuestJob(
  config: HyperVSandboxOptions,
  vm: HyperVVm,
  ipAddress: string,
  sshKeyPath: string,
  jitConfig: string,
) {
  const sshScript = [
    "read -r jitconfig || exit 1",
    `cd ${shellQuote(config.runnerDirectory)}`,
    "if [ ! -x ./run.sh ] || [ -e .runner ] || [ -e .credentials ] || [ -e .credentials_rsaparams ] || [ -e .service ]; then echo 'Template runner must be installed and unconfigured.' >&2; exit 2; fi",
    "if [ \"$(uname -s)\" != Linux ] || [ \"$(uname -m)\" != x86_64 ]; then echo 'Template must be a Linux x64 guest.' >&2; exit 2; fi",
    "if ! docker info >/dev/null 2>&1; then echo 'Docker Engine is not ready for the guest runner account.' >&2; exit 3; fi",
    "set +e",
    "./run.sh --jitconfig \"$jitconfig\"",
    "runner_status=$?",
    "unset jitconfig",
    "exit \"$runner_status\"",
  ].join("\n");
  const result = await execCommand("ssh", [
    "-i", sshKeyPath,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${vm.knownHostsPath}`,
    "-o", "GlobalKnownHostsFile=NUL",
    "-o", "IdentitiesOnly=yes",
    `${config.sshUser}@${ipAddress}`,
    `bash -lc ${shellQuote(sshScript)}`,
  ], { input: `${jitConfig}\n`, timeoutMs: 6 * 60 * 60 * 1000, signal: config.signal });
  return {
    ...result,
    stdout: redactSecret(result.stdout, jitConfig),
    stderr: redactSecret(result.stderr, jitConfig),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function removeVm(vm: HyperVVm, templatePath: string): Promise<void> {
  const sandboxRoot = path.resolve(SANDBOX_ROOT);
  const vmDirectory = path.resolve(path.dirname(vm.diskPath));
  const expectedVmDirectory = path.join(sandboxRoot, vm.name);
  if (!/^dgrunner-job-[a-f0-9]{32}$/.test(vm.name) || vmDirectory !== path.resolve(expectedVmDirectory) ||
      path.resolve(vm.diskPath) !== path.join(vmDirectory, `${vm.name}.vhdx`)) {
    throw new Error("Refusing to remove a sandbox path outside dgrunner's managed VM directory.");
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$cfg = $json | ConvertFrom-Json
$vm = Get-VM -Name $cfg.name -ErrorAction SilentlyContinue
if ($vm) {
  $expectedNote = 'Managed by dgrunner ephemeral sandbox: ' + $cfg.diskPath
  if ($vm.Notes -ne $expectedNote) { throw 'Refusing to remove a VM without the expected dgrunner ownership marker.' }
  $drives = @(Get-VMHardDiskDrive -VMName $cfg.name -ErrorAction Stop)
  if ($drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -ne [IO.Path]::GetFullPath($cfg.diskPath)) {
    throw 'Refusing to remove a VM whose attached disk does not match its dgrunner sandbox disk.'
  }
  $vhd = Get-VHD -Path $cfg.diskPath -ErrorAction Stop
  if ([IO.Path]::GetFullPath($vhd.ParentPath) -ne [IO.Path]::GetFullPath($cfg.templatePath)) {
    throw 'Refusing to remove a VM disk that is not a differencing child of the expected template.'
  }
  if ($vm.State -eq 'Running') { Stop-VM -Name $cfg.name -TurnOff -Force -ErrorAction Stop }
  Remove-VM -Name $cfg.name -Force -ErrorAction Stop
}
if (Test-Path -LiteralPath $cfg.diskPath -PathType Leaf) {
  $vhd = Get-VHD -Path $cfg.diskPath -ErrorAction Stop
  if ([IO.Path]::GetFullPath($vhd.ParentPath) -ne [IO.Path]::GetFullPath($cfg.templatePath)) {
    throw 'Refusing to delete a disk that is not a differencing child of the expected template.'
  }
  Remove-Item -LiteralPath $cfg.diskPath -Force -ErrorAction Stop
}
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
  const result = await execCommand(HYPERV_PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: encodePowerShellJson({ name: vm.name, diskPath: vm.diskPath, templatePath }),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Hyper-V refused to remove the sandbox VM.");
  await fs.rm(vmDirectory, { recursive: true, force: true });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
