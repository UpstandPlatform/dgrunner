import path from "node:path";
import os from "node:os";
import { Command, Option } from "commander";
import pc from "picocolors";
import { input, password, select, confirm } from "@inquirer/prompts";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";
import { runDoctorChecks } from "../core/doctor.js";
import {
  normalizeRunnerLabels,
  validateGitHubUrl,
  validateRegistrationToken,
  validateRunnerLabels,
  validateRunnerName,
} from "../core/security.js";
import { downloadAndInstallRunner } from "../core/runner-installer.js";
import { configureRunner, installService, startService } from "../core/runner-manager.js";
import {
  startDockerRunner,
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  DOCKER_DISTRO_PRESETS,
  getDefaultDockerRunnerName,
  validateDockerContainerName,
  validateDockerImageReference,
  getDockerArchitectureLabel,
} from "../core/docker-runner.js";
import {
  isWsl,
  detectLinuxDistro,
  getInstalledWslDistros,
  getAvailableOnlineWslDistros,
} from "../core/wsl.js";
import { writeVerificationWorkflow } from "../core/guide.js";
import { execCommand, execInteractive } from "../utils/exec.js";
import { logger, maskToken } from "../utils/logger.js";

export interface SetupOptions {
  url?: string;
  token?: string;
  name?: string;
  labels?: string;
  dir?: string;
  force?: boolean;
  service?: boolean;
  interactive?: boolean;
  os?: string;
  env?: string;
  distro?: string;
  image?: string;
  dockerSocket?: boolean;
  containerName?: string;
}

const WSL_SETUP_COMMAND = [
  "if ! command -v npx >/dev/null 2>&1; then echo 'Node.js/npm is not installed in WSL. Please install Node.js in WSL first.' >&2; exit 127; fi",
  'exec npx @upstand/dgrunner setup "$@"',
].join("; ");

export function buildWslSetupArgs(options: SetupOptions, distro?: string): string[] {
  const setupArgs: string[] = [];
  const addOption = (flag: string, value: string | undefined) => {
    if (value !== undefined && value !== "") setupArgs.push(flag, value);
  };

  addOption("--url", options.url);
  addOption("--name", options.name);
  addOption("--labels", options.labels);
  setupArgs.push("--env", "wsl");
  if (options.dir && options.dir.toLowerCase() !== DEFAULT_RUNNER_DIR.toLowerCase()) {
    addOption("--dir", options.dir);
  }
  if (options.force) setupArgs.push("--force");
  if (options.service === false) setupArgs.push("--no-service");

  return [
    ...(distro ? ["-d", distro] : []),
    "bash",
    "-l",
    "-c",
    WSL_SETUP_COMMAND,
    "dgrunner",
    ...setupArgs,
  ];
}

export async function runSetupFlow(options: SetupOptions = {}): Promise<void> {
  logger.header("dgrunner Setup Wizard");

  // Step 0: Resolve Target Runner Environment
  let targetEnv: "windows" | "docker" | "wsl" | "native" | undefined;

  if (options.env) {
    const norm = options.env.toLowerCase();
    if (norm === "docker" || norm === "wsl" || norm === "windows" || norm === "native") {
      // "native" means the current host OS. Preserve Windows labels and paths
      // when users explicitly choose native mode from Windows.
      targetEnv = norm === "native" && process.platform === "win32" ? "windows" : norm;
    } else {
      logger.error(`Unsupported target environment '${options.env}'.`);
      process.exitCode = 1;
      return;
    }
  } else if (options.os) {
    const norm = options.os.toLowerCase();
    if (norm === "linux") {
      targetEnv = process.platform === "win32" ? "docker" : "native";
    } else if (norm === "windows") {
      targetEnv = "windows";
    } else {
      logger.error(`Unsupported target OS '${options.os}'. Choose windows or linux.`);
      process.exitCode = 1;
      return;
    }
  }

  const isInteractive = !options.url || !options.token;

  if (isInteractive && !targetEnv) {
    console.log(pc.dim("  Press Ctrl+C at any time to cancel.\n"));

    if (process.platform === "win32") {
      targetEnv = await select({
        message: "Select runner target environment:",
        choices: [
          {
            name: "1. Windows Native (Host Service) - Runs natively on Windows for PowerShell / Windows jobs",
            value: "windows",
          },
          {
            name: "2. Linux Container (via Docker)  - Spins up an authentic Linux runner inside Docker for Linux/Bash jobs",
            value: "docker",
          },
          {
            name: "3. WSL2 Linux Environment        - Run natively inside Windows Subsystem for Linux (WSL)",
            value: "wsl",
          },
        ],
      });
    } else {
      targetEnv = await select({
        message: "Select runner target environment:",
        choices: [
          {
            name: "1. Linux Native (Host Service)  - Runs natively on Linux system",
            value: "native",
          },
          {
            name: "2. Linux Container (via Docker) - Spins up an authentic Linux runner container in Docker",
            value: "docker",
          },
        ],
      });
    }
  }

  // Fallback default
  if (!targetEnv) {
    targetEnv = process.platform === "win32" ? "windows" : "native";
  }

  if (options.env && options.os) {
    const requestedOsTarget = options.os.toLowerCase() === "linux"
      ? (process.platform === "win32" ? "docker" : "native")
      : "windows";
    if (targetEnv !== requestedOsTarget) {
      logger.error("--os conflicts with --env; use one consistent target.");
      process.exitCode = 1;
      return;
    }
  }

  if (targetEnv === "windows" && process.platform !== "win32") {
    logger.error("Windows native runners can only be configured from a Windows host. Use --env native or --env docker on Linux.");
    process.exitCode = 1;
    return;
  }
  if (targetEnv === "wsl" && process.platform !== "win32" && !isWsl()) {
    logger.error("WSL runners must be configured from Windows or from inside a WSL distribution.");
    process.exitCode = 1;
    return;
  }
  if ((options.image || options.dockerSocket) && targetEnv !== "docker") {
    logger.error("--image and --docker-socket can only be used with Docker runner setup (--env docker).");
    process.exitCode = 1;
    return;
  }
  if (options.distro && targetEnv !== "docker" && targetEnv !== "wsl") {
    logger.error("--distro can only be used with Docker or WSL runner setup.");
    process.exitCode = 1;
    return;
  }
  if (options.service === false && targetEnv === "docker") {
    logger.error("--no-service is not supported for Docker runners because the runner needs a persistent container.");
    process.exitCode = 1;
    return;
  }
  if (targetEnv === "docker" && !getDockerArchitectureLabel()) {
    logger.error(`Docker runners are supported only on x64 or arm64 hosts (received ${process.arch}).`);
    process.exitCode = 1;
    return;
  }

  if (options.containerName && targetEnv !== "docker") {
    logger.error("--container-name can only be used with Docker runner setup (--env docker).");
    process.exitCode = 1;
    return;
  }
  if (options.containerName) {
    const containerNameError = validateDockerContainerName(options.containerName);
    if (containerNameError) {
      logger.error(containerNameError);
      process.exitCode = 1;
      return;
    }
  }

  // Handle WSL option when selected on Windows
  if (targetEnv === "wsl" && process.platform === "win32") {
    const installedDistros = await getInstalledWslDistros();
    let selectedWslDistro = options.distro;

    if (isInteractive && !selectedWslDistro) {
      if (installedDistros.length > 0) {
        const choices = installedDistros.map((d) => ({
          name: `${d} (Installed)`,
          value: d,
        }));
        choices.push({
          name: "+ Install a new Linux distribution from Microsoft...",
          value: "__install_new__",
        });

        const chosen = await select({
          message: "Select WSL2 Linux distribution to use for the runner:",
          choices,
        });

        if (chosen === "__install_new__") {
          logger.info("Fetching available Linux distributions from Microsoft...");
          const onlineDistros = await getAvailableOnlineWslDistros();
          const distroToInstall = await select({
            message: "Choose a distribution to install:",
            choices: onlineDistros.map((d) => ({ name: d, value: d })),
          });

          logger.info(`Installing WSL distribution ${distroToInstall}...`);
          logger.dim(`  Running: wsl.exe --install -d ${distroToInstall}`);
          await execInteractive("wsl.exe", ["--install", "-d", distroToInstall]);
          selectedWslDistro = distroToInstall;
        } else {
          selectedWslDistro = chosen;
        }
      } else {
        logger.warn("No WSL2 Linux distributions found installed on this machine.");
        const installNow = await confirm({
          message: "Would you like to install Ubuntu in WSL2 now?",
          default: true,
        });
        if (installNow) {
          logger.info("Installing Ubuntu in WSL2...");
          await execInteractive("wsl.exe", ["--install", "-d", "Ubuntu"]);
          selectedWslDistro = "Ubuntu";
        }
      }
    }

    const distroFlag = selectedWslDistro ? `-d ${selectedWslDistro} ` : "";
    const distroName = selectedWslDistro || "default";

    logger.box(
      `WSL2 LINUX RUNNER SETUP (${distroName})`,
      [
        `To set up and run your runner inside WSL2 [${distroName}]:`,
        "",
        `1. Open your WSL terminal:  ${pc.cyan(`wsl ${distroFlag}`)}`,
        `2. Run dgrunner inside WSL: ${pc.cyan("npx @upstand/dgrunner setup")}`,
        "",
        pc.dim("Docker Desktop Tip: Ensure WSL integration is enabled:"),
        pc.dim(`Docker Desktop Settings -> Resources -> WSL Integration -> Turn ON for ${distroName}`),
      ],
      "cyan"
    );

    const wslCmdArgs = buildWslSetupArgs(options, selectedWslDistro);
    if (!isInteractive) {
      if (options.token) logger.info("The registration token will be prompted inside WSL so it is not forwarded in the WSL command line.");
      logger.info(`Transferring non-interactive setup into WSL2 [${distroName}]...`);
      const exitCode = await execInteractive("wsl.exe", wslCmdArgs);
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    try {
      const launch = await confirm({
        message: `Would you like to transfer setup to your WSL2 distribution [${distroName}] now?`,
        default: true,
      });

      if (launch) {
        if (options.token) logger.info("The registration token will be prompted inside WSL so it is not forwarded in the WSL command line.");
        logger.info(`Transferring execution into WSL2 [${distroName}]...`);
        const exitCode = await execInteractive("wsl.exe", wslCmdArgs);
        if (exitCode !== 0) process.exitCode = exitCode;
        return;
      }
    } catch {
    }
    return;
  }

  // Step 1: Pre-flight Security & Environment Checks
  logger.step(1, 4, "Running pre-flight security checks...");
  const installDir = options.dir || DEFAULT_RUNNER_DIR;
  const report = await runDoctorChecks({
    targetDir: installDir,
    targetEnv,
  });

  if (!report.ok) {
    if (!options.force) {
      logger.securityAlert(
        "Critical pre-flight checks failed! To protect your machine, setup is blocked.\n" +
        "Run 'dgrunner doctor' to see recommendations, or rerun with --force to override."
      );
      process.exit(1);
    } else {
      logger.warn("Critical pre-flight checks failed, but continuing due to --force flag.");
      for (const check of report.checks.filter((entry) => entry.status === "fail")) {
        logger.warn(`${check.name}: ${check.message}`);
      }
    }
  } else if (report.hasWarnings) {
    logger.warn("Pre-flight checks passed with warnings:");
    for (const check of report.checks.filter((entry) => entry.status === "warn")) {
      logger.warn(`${check.name}: ${check.message}`);
      if (check.remediation) logger.dim(`  Fix: ${check.remediation}`);
    }
  } else {
    logger.success("Pre-flight checks passed.");
  }

  // Step 2: Resolve Configuration Parameters
  logger.step(2, 4, "Configuring GitHub Actions Runner parameters...");

  let selectedDistro = options.distro;
  let customImage = options.image?.trim() || undefined;

  if (targetEnv === "docker") {
    if (isInteractive && !selectedDistro && !customImage) {
      const distroChoice = await select({
        message: "Select Linux distribution for Docker runner:",
        choices: [
          {
            name: "1. Ubuntu 24.04 LTS (Noble) - Recommended (Default GitHub Actions runner)",
            value: "ubuntu-24.04",
          },
          {
            name: "2. Ubuntu 22.04 LTS (Jammy) - Broad legacy toolchain compatibility",
            value: "ubuntu-22.04",
          },
          {
            name: "3. Debian (Bookworm)         - Lightweight Debian-compatible environment",
            value: "debian",
          },
          {
            name: "4. Custom Docker Image       - Provide your own custom runner image",
            value: "custom",
          },
        ],
      });

      if (distroChoice === "custom") {
        customImage = (await input({
          message: "Enter custom Docker runner image tag (e.g. my-org/actions-runner:latest):",
          validate: (val) => (val.trim().length > 0 ? true : "Image tag cannot be empty"),
        })).trim();
        selectedDistro = "custom";
      } else {
        selectedDistro = distroChoice;
      }
    }
  }

  const presetKey = selectedDistro ? selectedDistro.toLowerCase() : undefined;
  const dockerPreset = presetKey ? DOCKER_DISTRO_PRESETS[presetKey] : undefined;
  if (targetEnv === "docker" && selectedDistro && !dockerPreset && selectedDistro.toLowerCase() !== "custom") {
    logger.error(`Unsupported Docker distro '${selectedDistro}'. Choose ubuntu-24.04, ubuntu-22.04, debian, or provide --image.`);
    process.exitCode = 1;
    return;
  }
  if (targetEnv === "docker" && selectedDistro?.toLowerCase() === "custom" && !customImage) {
    logger.error("The custom Docker distro requires an image supplied with --image.");
    process.exitCode = 1;
    return;
  }
  const targetImage = customImage || dockerPreset?.image || DEFAULT_DOCKER_RUNNER_IMAGE;
  const imageValidationError = targetEnv === "docker" ? validateDockerImageReference(targetImage) : null;
  if (imageValidationError) {
    logger.error(imageValidationError);
    process.exitCode = 1;
    return;
  }
  const targetDistroName = dockerPreset?.name || (customImage ? "Custom Docker Image" : (selectedDistro || "Ubuntu 24.04 LTS (Noble)"));

  let targetUrl = options.url;
  let token = options.token;
  let runnerName = options.name;
  let labels = options.labels !== undefined
    ? normalizeRunnerLabels(options.labels.split(","))
    : undefined;
  if (labels?.length === 0) labels = undefined;

  const hostDistro = await detectLinuxDistro();
  const runningInWsl = isWsl();
  const defaultRunnerName = targetEnv === "docker"
    ? getDefaultDockerRunnerName(options.containerName || DEFAULT_CONTAINER_NAME)
    : targetEnv === "windows"
      ? `${os.hostname().toLowerCase()}-dgrunner`
      : `${os.hostname().toLowerCase()}-linux`;
  const defaultRunnerLabels = targetEnv === "docker"
    ? (dockerPreset
        ? [...dockerPreset.defaultLabels]
        : ["self-hosted", "linux", getDockerArchitectureLabel() || "x64", "docker", "dgrunner"])
    : targetEnv === "windows"
      ? ["self-hosted", "dgrunner", "windows", process.arch]
      : runningInWsl
        ? ["self-hosted", "dgrunner", "linux", "wsl", hostDistro?.id || "ubuntu", process.arch]
        : ["self-hosted", "dgrunner", "linux", hostDistro?.id || "linux", process.arch];

  if (isInteractive) {
    if (!targetUrl) {
      const scopeChoice = await select({
        message: "What scope are you registering this runner for?",
        choices: [
          { name: "Private Repository (Recommended)", value: "repo" },
          { name: "Organization", value: "org" },
        ],
      });
      targetUrl = await input({
        message: scopeChoice === "repo"
          ? "Enter private GitHub repository URL (e.g. https://github.com/owner/repo):"
          : "Enter GitHub organization URL (e.g. https://github.com/my-org):",
        validate: (val) => {
          const res = validateGitHubUrl(val);
          return res.valid ? true : res.error || "Invalid URL";
        },
      });
    }

    targetUrl = targetUrl.trim();
    const urlValidation = validateGitHubUrl(targetUrl);
    if (!urlValidation.valid) {
      logger.error(`Invalid URL: ${urlValidation.error}`);
      process.exit(1);
      return;
    }

    if (!token) {
      console.log(pc.dim(`  Get your token from: ${targetUrl}/settings/actions/runners/new`));
      token = await password({
        message: "Paste your short-lived registration token (hidden):",
        mask: "*",
        validate: (val) => {
          const res = validateRegistrationToken(val);
          return res.valid ? true : res.error || "Invalid token";
        },
      });
    }

    if (!runnerName) {
      runnerName = await input({
        message: "Enter runner name:",
        default: defaultRunnerName,
      });
    }

    if (!labels) {
      const labelsInput = await input({
        message: "Enter custom runner labels (comma-separated):",
        default: defaultRunnerLabels.join(","),
      });
      labels = normalizeRunnerLabels(labelsInput.split(","));
    }
  } else {
    // Validate provided CLI options
    targetUrl = targetUrl?.trim();
    const urlValidation = validateGitHubUrl(targetUrl!);
    if (!urlValidation.valid) {
      logger.error(`Invalid URL: ${urlValidation.error}`);
      process.exit(1);
    }

    const tokenValidation = validateRegistrationToken(token!);
    if (!tokenValidation.valid) {
      logger.error(`Invalid token: ${tokenValidation.error}`);
      process.exit(1);
    }

    if (!runnerName) {
      runnerName = defaultRunnerName;
    }

    if (!labels) {
      labels = [...defaultRunnerLabels];
    }
  }

  const labelsValidation = validateRunnerLabels(labels || []);
  if (!labelsValidation.valid) {
    logger.error(labelsValidation.error || "Invalid runner labels.");
    process.exitCode = 1;
    return;
  }
  runnerName = runnerName?.trim();
  const runnerNameValidation = runnerName ? validateRunnerName(runnerName) : { valid: false, error: "Runner name cannot be empty." };
  if (!runnerNameValidation.valid) {
    logger.error(runnerNameValidation.error || "Invalid runner name.");
    process.exitCode = 1;
    return;
  }

  // Step 3 & 4: Execution based on Target Environment
  if (targetEnv === "docker") {
    const containerName = options.containerName || DEFAULT_CONTAINER_NAME;
    // Docker Container Runner
    logger.step(3, 4, `Verifying Linux runner container image [${targetDistroName}]...`);
    logger.dim(`  → Checking / pulling ${targetImage}...`);

    const pullRes = await execCommand("docker", ["pull", targetImage], {
      timeoutMs: 180000,
    });
    if (pullRes.exitCode === 0) {
      logger.success("Linux runner container image verified.");
    } else {
      logger.info("Proceeding with cached container image...");
    }

    logger.step(4, 4, `Registering & starting Linux runner container in Docker [${targetDistroName}]...`);
    const dockerRes = await startDockerRunner({
      containerName,
      url: targetUrl!,
      token: token!,
      runnerName,
      labels,
      image: targetImage,
      distro: selectedDistro || targetDistroName,
      mountDockerSocket: options.dockerSocket === true,
    });

    if (!dockerRes.success) {
      logger.error("Runner container start failed!");
      console.error(dockerRes.output);
      process.exit(1);
    }

    logger.success("Runner container launched and registered with GitHub!");

    // Offer to generate test workflow if in interactive mode
    if (isInteractive) {
      try {
        const genWf = await confirm({
          message: "Would you like to generate a test workflow (.github/workflows/verify-runner.yml) in the current directory?",
          default: true,
        });

        if (genWf) {
          const wfPath = await writeVerificationWorkflow(process.cwd(), {
            runnerName,
            labels,
          });
          logger.success(`Verification workflow generated at: ${pc.bold(wfPath)}`);
        }
      } catch (error) {
        logger.warn(`Could not generate verification workflow: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Summary Box for Docker Runner
    logger.box(
      "RUNNER SETUP COMPLETE",
      [
        `Name:        ${pc.bold(runnerName)}`,
        `Target URL:  ${pc.bold(targetUrl!)}`,
        `Labels:      ${labels.join(", ")}`,
        `Environment: ${pc.cyan("Linux Container (via Docker)")}`,
        `Distro:      ${pc.green(targetDistroName)}`,
        `Image:       ${pc.dim(targetImage)}`,
        `Container:   ${pc.bold(containerName)}`,
        `Restart:     ${pc.green("unless-stopped (automatic reconnect)")}`,
        `Token:       ${maskToken(token!)} (used ephemerally, not stored)`,
        "",
        pc.green("✔ Your PC + Docker is now active as an authentic Linux self-hosted runner!"),
        "",
        `Check status:   ${pc.cyan(`dgrunner status --runner ${containerName}`)}`,
        `View live logs: ${pc.cyan(`dgrunner logs --runner ${containerName} --follow`)}`,
        `List processes: ${pc.cyan("dgrunner ps")}`,
        `Stop runner:    ${pc.cyan(`dgrunner stop --runner ${containerName}`)}`,
      ],
      "green"
    );
  } else {
    // Native Host Runner (Windows or Linux Host)
    logger.step(3, 4, "Downloading & extracting verified runner binary...");
    try {
      await downloadAndInstallRunner(installDir, (msg) => logger.dim(`  → ${msg}`));
      logger.success("Runner package installed & verified.");
    } catch (err: any) {
      logger.error(`Installation failed: ${err.message}`);
      process.exit(1);
    }

    const effectiveMode = runningInWsl ? "wsl" : "native";
    const hostDistroName = hostDistro?.name || (process.platform === "win32" ? "Windows Native" : "Linux Native");

    logger.step(4, 4, "Registering runner with GitHub...");
    const configRes = await configureRunner({
      runnerDir: installDir,
      url: targetUrl!,
      token: token!,
      name: runnerName,
      labels,
      replace: true,
      mode: effectiveMode,
      distro: hostDistroName,
    });

    if (!configRes.success) {
      logger.error("Runner registration failed!");
      console.error(configRes.output);
      process.exit(1);
    }

    logger.success("Runner successfully registered with GitHub!");

    // Install and start service if requested
    const shouldInstallService = options.service !== false;
    let runnerRunning = false;
    if (shouldInstallService) {
      logger.info(process.platform === "win32"
        ? "Starting the Windows runner as a background process..."
        : "Setting up the persistent Linux runner service...");
      let serviceReady = true;
      if (process.platform !== "win32") {
        const installRes = await installService(installDir);
        if (!installRes.success) {
          serviceReady = false;
          process.exitCode = 1;
          logger.error(`Could not install runner service: ${installRes.message}`);
        }
      }
      if (serviceReady) {
        const startRes = await startService(installDir);
        if (startRes.success) {
          runnerRunning = true;
          logger.success(process.platform === "win32"
            ? "Runner background process started. It does not auto-start after Windows sign-out or reboot."
            : "Persistent runner service started in the background.");
        } else {
          process.exitCode = 1;
          logger.error(`Could not start the runner: ${startRes.message}`);
          logger.info(`You can start it manually with: ${pc.cyan("dgrunner run")}`);
        }
      }
    } else {
      logger.info("Runner registered with GitHub and left stopped as requested.");
    }

    // Offer to generate test workflow if in interactive mode
    if (isInteractive) {
      try {
        const genWf = await confirm({
          message: "Would you like to generate a test workflow (.github/workflows/verify-runner.yml) in the current directory?",
          default: true,
        });

        if (genWf) {
          const wfPath = await writeVerificationWorkflow(process.cwd(), {
            runnerName,
            labels,
          });
          logger.success(`Verification workflow generated at: ${pc.bold(wfPath)}`);
        }
      } catch (error) {
        logger.warn(`Could not generate verification workflow: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Summary Box for Host Runner
    logger.box(
      "RUNNER SETUP COMPLETE",
      [
        `Name:        ${pc.bold(runnerName)}`,
        `Target URL:  ${pc.bold(targetUrl!)}`,
        `Labels:      ${labels.join(", ")}`,
        `Environment: ${pc.cyan(runningInWsl ? `WSL2 Linux (${hostDistroName})` : process.platform === "win32" ? "Windows Native (background process)" : `Linux Native (${hostDistroName})`)}`,
        `Directory:   ${installDir}`,
        `Token:       ${maskToken(token!)} (used ephemerally, not stored)`,
        "",
        runnerRunning
          ? pc.green("✔ Your PC is now active as a self-hosted runner.")
          : pc.yellow("Runner registered with GitHub but is not currently running."),
        "",
        `Check status:   ${pc.cyan("dgrunner status")}`,
        `View live logs: ${pc.cyan("dgrunner logs --follow")}`,
        `List processes: ${pc.cyan("dgrunner ps")}`,
        runnerRunning
          ? `Stop runner:    ${pc.cyan("dgrunner stop")}`
          : `Start runner:   ${pc.cyan("dgrunner run")}`,
      ],
      "green"
    );
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Set up, configure, and start the self-hosted GitHub Actions runner")
    .option("-u, --url <url>", "GitHub repository or organization URL")
    .option("-t, --token <token>", "GitHub runner registration token (may be exposed in shell history and process listings)")
    .option("-n, --name <name>", "Runner name")
    .option("-l, --labels <labels>", "Comma-separated custom runner labels")
    .option("-d, --dir <path>", "Runner installation directory", DEFAULT_RUNNER_DIR)
    .addOption(new Option("--os <os>", "Target runner OS: 'windows' or 'linux' (on Windows, 'linux' uses Docker container)").choices(["windows", "linux"]))
    .addOption(new Option("--env <environment>", "Target runner environment: 'windows', 'docker', 'wsl', or 'native'")
      .choices(["windows", "docker", "wsl", "native"]))
    .option("--distro <distro>", "Linux distribution preset ('ubuntu-24.04', 'ubuntu-22.04', 'debian') or WSL distro name")
    .option("--image <image>", "Custom Docker runner container image")
    .option("--container-name <name>", "Docker container name (use a unique name for each Docker runner)")
    .option("--docker-socket", "Mount the host Docker socket into the runner (grants workflows host-level Docker control)", false)
    .option("--force", "Ignore critical pre-flight check failures and proceed", false)
    .option("--no-service", "Do not install or start persistent background service")
    .action(async (options) => {
      await runSetupFlow(options);
    });
}
