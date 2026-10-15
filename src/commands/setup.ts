import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import pc from "picocolors";
import { input, password, select, confirm } from "@inquirer/prompts";
import { DEFAULT_RUNNER_DIR } from "../config/constants.js";
import { runDoctorChecks } from "../core/doctor.js";
import { validateGitHubUrl, validateRegistrationToken } from "../core/security.js";
import { downloadAndInstallRunner } from "../core/runner-installer.js";
import { configureRunner, installService, startService } from "../core/runner-manager.js";
import {
  startDockerRunner,
  DEFAULT_CONTAINER_NAME,
  DEFAULT_DOCKER_RUNNER_IMAGE,
  DOCKER_DISTRO_PRESETS,
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
  noDockerSocket?: boolean;
}

export async function runSetupFlow(options: SetupOptions = {}): Promise<void> {
  logger.header("dgrunner Setup Wizard");

  // Step 0: Resolve Target Runner Environment
  let targetEnv: "windows" | "docker" | "wsl" | "native" | undefined;

  if (options.env) {
    const norm = options.env.toLowerCase();
    if (norm === "docker" || norm === "wsl" || norm === "windows" || norm === "native") {
      targetEnv = norm as any;
    }
  } else if (options.os) {
    const norm = options.os.toLowerCase();
    if (norm === "linux") {
      targetEnv = process.platform === "win32" ? "docker" : "native";
    } else if (norm === "windows") {
      targetEnv = "windows";
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

    if (isInteractive) {
      try {
        const launch = await confirm({
          message: `Would you like to transfer setup to your WSL2 distribution [${distroName}] now?`,
          default: true,
        });

        if (launch) {
          logger.info(`Transferring execution into WSL2 [${distroName}]...`);
          const wslCmdArgs = selectedWslDistro
            ? ["-d", selectedWslDistro, "bash", "-c", "which npx >/dev/null 2>&1 && npx @upstand/dgrunner setup || (echo 'Node.js/npm is not installed in WSL. Please install Node.js in WSL first.')"]
            : ["bash", "-c", "which npx >/dev/null 2>&1 && npx @upstand/dgrunner setup || (echo 'Node.js/npm is not installed in WSL. Please install Node.js in WSL first.')"];
          await execInteractive("wsl.exe", wslCmdArgs);
          return;
        }
      } catch {}
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
    }
  } else {
    logger.success("Pre-flight checks passed.");
  }

  // Step 2: Resolve Configuration Parameters
  logger.step(2, 4, "Configuring GitHub Actions Runner parameters...");

  let selectedDistro = options.distro;
  let customImage = options.image;

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
        customImage = await input({
          message: "Enter custom Docker runner image tag (e.g. my-org/actions-runner:latest):",
          validate: (val) => (val.trim().length > 0 ? true : "Image tag cannot be empty"),
        });
        selectedDistro = "custom";
      } else {
        selectedDistro = distroChoice;
      }
    }
  }

  const presetKey = selectedDistro ? selectedDistro.toLowerCase() : undefined;
  const dockerPreset = presetKey ? DOCKER_DISTRO_PRESETS[presetKey] : undefined;
  const targetImage = customImage || dockerPreset?.image || DEFAULT_DOCKER_RUNNER_IMAGE;
  const targetDistroName = dockerPreset?.name || (customImage ? "Custom Docker Image" : (selectedDistro || "Ubuntu 24.04 LTS (Noble)"));

  let targetUrl = options.url;
  let token = options.token;
  let runnerName = options.name;
  let labels = options.labels ? options.labels.split(",").map((l) => l.trim()) : undefined;

  const hostDistro = await detectLinuxDistro();
  const runningInWsl = isWsl();

  if (isInteractive) {
    const scopeChoice = await select({
      message: "What scope are you registering this runner for?",
      choices: [
        { name: "Private Repository (Recommended)", value: "repo" },
        { name: "Organization", value: "org" },
      ],
    });

    if (!targetUrl) {
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
      const defaultName =
        targetEnv === "docker"
          ? `${os.hostname().toLowerCase()}-linux-docker`
          : targetEnv === "windows"
          ? `${os.hostname().toLowerCase()}-dgrunner`
          : `${os.hostname().toLowerCase()}-linux`;

      runnerName = await input({
        message: "Enter runner name:",
        default: defaultName,
      });
    }

    if (!labels) {
      const defaultLabels =
        targetEnv === "docker"
          ? (dockerPreset ? dockerPreset.defaultLabels.join(",") : "self-hosted,linux,x64,docker,dgrunner")
          : targetEnv === "windows"
          ? "self-hosted,dgrunner,windows,x64"
          : (runningInWsl
              ? `self-hosted,dgrunner,linux,wsl,${hostDistro?.id || "ubuntu"},${process.arch}`
              : `self-hosted,dgrunner,linux,${hostDistro?.id || "linux"},${process.arch}`);

      const labelsInput = await input({
        message: "Enter custom runner labels (comma-separated):",
        default: defaultLabels,
      });
      labels = labelsInput.split(",").map((l) => l.trim()).filter(Boolean);
    }
  } else {
    // Validate provided CLI options
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
      runnerName =
        targetEnv === "docker"
          ? `${os.hostname().toLowerCase()}-linux-docker`
          : targetEnv === "windows"
          ? `${os.hostname().toLowerCase()}-dgrunner`
          : `${os.hostname().toLowerCase()}-linux`;
    }

    if (!labels) {
      labels =
        targetEnv === "docker"
          ? (dockerPreset ? [...dockerPreset.defaultLabels] : ["self-hosted", "linux", "x64", "docker", "dgrunner"])
          : targetEnv === "windows"
          ? ["self-hosted", "dgrunner", "windows", "x64"]
          : (runningInWsl
              ? ["self-hosted", "dgrunner", "linux", "wsl", hostDistro?.id || "ubuntu", process.arch]
              : ["self-hosted", "dgrunner", "linux", hostDistro?.id || "linux", process.arch]);
    }
  }

  // Step 3 & 4: Execution based on Target Environment
  if (targetEnv === "docker") {
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
      url: targetUrl!,
      token: token!,
      runnerName,
      labels,
      image: targetImage,
      distro: selectedDistro || targetDistroName,
      mountDockerSocket: !options.noDockerSocket,
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
      } catch {}
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
        `Container:   ${pc.bold(DEFAULT_CONTAINER_NAME)}`,
        `Restart:     ${pc.green("unless-stopped (automatic reconnect)")}`,
        `Token:       ${maskToken(token!)} (used ephemerally, not stored)`,
        "",
        pc.green("✔ Your PC + Docker is now active as an authentic Linux self-hosted runner!"),
        "",
        `Check status:   ${pc.cyan("dgrunner status")}`,
        `View live logs: ${pc.cyan("dgrunner logs --follow")}`,
        `List processes: ${pc.cyan("dgrunner ps")}`,
        `Stop runner:    ${pc.cyan("dgrunner stop")}`,
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

    const effectiveMode = runningInWsl ? "wsl" : (process.platform === "win32" ? "native" : "native");
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
    if (shouldInstallService) {
      logger.info("Setting up persistent host runner service...");
      await installService(installDir);
      const startRes = await startService(installDir);
      if (startRes.success) {
        logger.success("Persistent runner service started in the background.");
      } else {
        logger.warn(`Could not start service automatically: ${startRes.message}`);
        logger.info(`You can start it manually with: ${pc.cyan("dgrunner start")}`);
      }
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
      } catch {}
    }

    // Summary Box for Host Runner
    logger.box(
      "RUNNER SETUP COMPLETE",
      [
        `Name:        ${pc.bold(runnerName)}`,
        `Target URL:  ${pc.bold(targetUrl!)}`,
        `Labels:      ${labels.join(", ")}`,
        `Environment: ${pc.cyan(runningInWsl ? `WSL2 Linux (${hostDistroName})` : process.platform === "win32" ? "Windows Native (Host Service)" : `Linux Native (${hostDistroName})`)}`,
        `Directory:   ${installDir}`,
        `Token:       ${maskToken(token!)} (used ephemerally, not stored)`,
        "",
        pc.green("✔ Your PC is now active as a secure self-hosted runner!"),
        "",
        `Check status:   ${pc.cyan("dgrunner status")}`,
        `View live logs: ${pc.cyan("dgrunner logs --follow")}`,
        `List processes: ${pc.cyan("dgrunner ps")}`,
        `Stop runner:    ${pc.cyan("dgrunner stop")}`,
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
    .option("-t, --token <token>", "GitHub runner registration token")
    .option("-n, --name <name>", "Runner name")
    .option("-l, --labels <labels>", "Comma-separated custom runner labels")
    .option("-d, --dir <path>", "Runner installation directory", DEFAULT_RUNNER_DIR)
    .option("--os <os>", "Target runner OS: 'windows' or 'linux' (on Windows, 'linux' uses Docker container)")
    .option("--env <environment>", "Target runner environment: 'windows', 'docker', 'wsl', or 'native'")
    .option("--distro <distro>", "Linux distribution preset ('ubuntu-24.04', 'ubuntu-22.04', 'debian') or WSL distro name")
    .option("--image <image>", "Custom Docker runner container image")
    .option("--no-docker-socket", "Do not mount /var/run/docker.sock into Docker runner container")
    .option("--force", "Ignore critical pre-flight check failures and proceed", false)
    .option("--no-service", "Do not install or start persistent background service", false)
    .action(async (options) => {
      await runSetupFlow(options);
    });
}
