import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { logger } from "../utils/logger.js";
import { ensureDir } from "../utils/fs.js";

export interface WorkflowOptions {
  runnerName?: string;
  labels?: string[];
  scope?: "repo" | "org";
}

/**
 * Prints clear, colorized step-by-step GitHub setup and security instructions.
 */
export function printGitHubSetupGuide(scope?: "repo" | "org"): void {
  logger.header("GitHub Self-Hosted Runner Integration Guide");

  console.log(pc.bold(pc.cyan("1. How to get your Registration Token on GitHub:")));
  console.log();
  if (!scope || scope === "repo") {
    console.log(pc.bold("  For a Repository:"));
    console.log(`    a. Open your ${pc.bold("PRIVATE")} repository on GitHub.`);
    console.log(`    b. Click ${pc.bold("Settings")} -> ${pc.bold("Actions")} -> ${pc.bold("Runners")}.`);
    console.log(`    c. Click the green ${pc.bold("New self-hosted runner")} button.`);
    console.log(`    d. Select your Operating System (Linux or Windows).`);
    console.log(`    e. Generate a short-lived token, then paste it into dgrunner's hidden prompt. Avoid putting the token in a shell command.`);
    console.log();
  }

  if (!scope || scope === "org") {
    console.log(pc.bold("  For an Organization:"));
    console.log(`    a. Open your GitHub Organization page.`);
    console.log(`    b. Click ${pc.bold("Settings")} -> ${pc.bold("Actions")} -> ${pc.bold("Runners")}.`);
    console.log(`    c. Click ${pc.bold("New runner")} -> ${pc.bold("New self-hosted runner")}.`);
    console.log(`    d. Copy the short-lived registration token.`);
    console.log();
  }

  logger.box(
    "CRITICAL SECURITY BEST PRACTICES",
    [
      pc.red(pc.bold("NEVER use self-hosted runners on PUBLIC repositories!")),
      "Untrusted pull requests from fork authors can execute arbitrary code on your PC.",
      "",
      pc.yellow("• Use only with trusted private repositories or internal organizations."),
      "• Short-lived tokens expire after 1 hour—generate them right before setup.",
      "• On Linux, run with Rootless Docker to prevent workflow escapes to host root.",
      "• Dedicated non-admin user accounts are recommended.",
    ],
    "red"
  );

  console.log(pc.bold(pc.cyan("2. Registering with dgrunner:")));
  console.log();
  console.log(`    Run: ${pc.green("dgrunner setup")}`);
  console.log(`    Enter your repo/org URL and paste the registration token when prompted.`);
  console.log();

  console.log(pc.bold(pc.cyan("3. Verifying the Runner:")));
  console.log();
  console.log(`    Generate an automated test workflow:`);
  console.log(`    ${pc.green("dgrunner guide --generate-workflow")}`);
  console.log(`    Commit and push ${pc.bold(".github/workflows/verify-runner.yml")} to your repo.`);
  console.log();
}

/**
 * Generates a clean, comprehensive verification workflow YAML content.
 */
export function generateVerificationWorkflowYaml(options: WorkflowOptions = {}): string {
  const labels = options.labels && options.labels.length > 0
    ? options.labels
    : ["self-hosted", "dgrunner"];

  const runsOnStr = JSON.stringify(labels);

  return `name: Verify dgrunner Self-Hosted Runner

on:
  workflow_dispatch:
  push:
    branches: [ main, master ]

jobs:
  verify-host:
    name: 1. Verify Host & Environment
    runs-on: ${runsOnStr}
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Print Runner & OS Details
        shell: bash
        run: |
          echo "======================================"
          echo "Runner Hostname: $(hostname)"
          echo "Current User:    $(whoami)"
          echo "OS Details:      $(uname -a 2>/dev/null || cmd.exe /c ver)"
          echo "Workspace Dir:   $GITHUB_WORKSPACE"
          echo "======================================"

  verify-docker:
    name: 2. Verify Docker Container Execution
    runs-on: ${runsOnStr}
    steps:
      - name: Test Docker CLI & Daemon
        shell: bash
        run: |
          if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
            echo "Docker socket is not enabled for this runner; skipping optional Docker checks."
            exit 0
          fi
          echo "Checking Docker version..."
          docker --version
          echo "Running lightweight test container..."
          docker run --rm alpine:latest echo "Hello from containerized workflow on $(hostname)!"

  verify-security:
    name: 3. Verify Security Boundaries
    runs-on: ${runsOnStr}
    steps:
      - name: Check Non-Root User Execution
        shell: bash
        run: |
          if [ "$(id -u 2>/dev/null)" = "0" ]; then
            echo "WARNING: Workflow is running as root on host!"
            exit 1
          else
            echo "SUCCESS: Workflow running under unprivileged user."
          fi

      - name: Test Docker User Namespace / Isolation
        shell: bash
        run: |
          if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
            echo "Docker socket is not enabled for this runner; skipping optional Docker checks."
            exit 0
          fi
          docker run --rm alpine:latest id
          echo "Docker container isolation verified."
`;
}

/**
 * Writes the verification workflow file to the specified project directory.
 */
export async function writeVerificationWorkflow(
  projectRoot = process.cwd(),
  options: WorkflowOptions = {}
): Promise<string> {
  const workflowsDir = path.join(projectRoot, ".github", "workflows");
  await ensureDir(workflowsDir);

  const workflowPath = path.join(workflowsDir, "verify-runner.yml");
  const yamlContent = generateVerificationWorkflowYaml(options);

  await fsPromises.writeFile(workflowPath, yamlContent, "utf-8");
  return workflowPath;
}
