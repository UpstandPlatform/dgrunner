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
import { writeVerificationWorkflow } from "../core/guide.js";
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
}

export async function runSetupFlow(options: SetupOptions = {}): Promise<void> {
  logger.header("dgrunner Setup Wizard");

  // Step 1: Pre-flight Security & Environment Checks
  logger.step(1, 4, "Running pre-flight security checks...");
  const installDir = options.dir || DEFAULT_RUNNER_DIR;
  const report = await runDoctorChecks(installDir);

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

  let targetUrl = options.url;
  let token = options.token;
  let runnerName = options.name;
  let labels = options.labels ? options.labels.split(",").map((l) => l.trim()) : undefined;

  const isInteractive = !targetUrl || !token;

  if (isInteractive) {
    console.log(pc.dim("  Press Ctrl+C at any time to cancel.\n"));

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
      const defaultName = `${os.hostname().toLowerCase()}-dgrunner`;
      runnerName = await input({
        message: "Enter runner name:",
        default: defaultName,
      });
    }

    if (!labels) {
      const defaultLabels = `self-hosted,dgrunner,${process.platform === "win32" ? "windows" : "linux"},${process.arch}`;
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
      runnerName = `${os.hostname().toLowerCase()}-dgrunner`;
    }

    if (!labels) {
      labels = ["self-hosted", "dgrunner", process.platform === "win32" ? "windows" : "linux", process.arch];
    }
  }

  // Step 3: Download & Verify Official Runner
  logger.step(3, 4, "Downloading & extracting verified runner binary...");
  try {
    await downloadAndInstallRunner(installDir, (msg) => logger.dim(`  → ${msg}`));
    logger.success("Runner package installed & verified.");
  } catch (err: any) {
    logger.error(`Installation failed: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Configure Runner & Service
  logger.step(4, 4, "Registering runner with GitHub...");
  const configRes = await configureRunner({
    runnerDir: installDir,
    url: targetUrl!,
    token: token!,
    name: runnerName,
    labels,
    replace: true,
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
    } catch {
      // User cancelled prompt
    }
  }

  // Summary Box
  logger.box(
    "RUNNER SETUP COMPLETE",
    [
      `Name:       ${pc.bold(runnerName)}`,
      `Target URL: ${pc.bold(targetUrl!)}`,
      `Labels:     ${labels.join(", ")}`,
      `Directory:  ${installDir}`,
      `Token:      ${maskToken(token!)} (used ephemerally, not stored)`,
      "",
      pc.green("✔ Your PC + Docker is now active as a secure self-hosted runner!"),
      "",
      `Check status anytime: ${pc.cyan("dgrunner status")}`,
      `Start/Stop service:   ${pc.cyan("dgrunner start")} / ${pc.cyan("dgrunner stop")}`,
    ],
    "green"
  );
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
    .option("--force", "Ignore critical pre-flight check failures and proceed", false)
    .option("--no-service", "Do not install or start persistent background service", false)
    .action(async (options) => {
      await runSetupFlow(options);
    });
}
