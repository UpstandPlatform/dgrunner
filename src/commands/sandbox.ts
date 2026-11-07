import { Command, Option } from "commander";
import { runHyperVSandbox } from "../core/hyperv-sandbox.js";
import { logger } from "../utils/logger.js";

export function registerSandboxCommand(program: Command): void {
  program
    .command("sandbox")
    .description("Run one-job Linux runners in disposable Hyper-V virtual machines")
    .command("run")
    .description("Keep one disposable Hyper-V VM available for jobs from a private GitHub repository")
    .requiredOption("-u, --url <url>", "Private GitHub repository URL")
    .requiredOption("-n, --name <prefix>", "Prefix for unique ephemeral runner names")
    .requiredOption("--template <path>", "Path to a clean, bootable Linux Hyper-V VHDX template")
    .requiredOption("--switch <name>", "Hyper-V virtual switch connected to the guest network")
    .requiredOption("--ssh-key <path>", "SSH private key authorized by the Linux template")
    .option("--ssh-user <name>", "Linux account in the guest template", "runner")
    .option("--runner-directory <path>", "GitHub Actions runner directory in the guest", "/home/runner/actions-runner")
    .option("--labels <labels>", "Comma-separated GitHub runner labels", "self-hosted,Linux,X64,dgrunner-vm")
    .option("--memory-gib <number>", "Guest VM startup memory in GiB", (value) => Number.parseInt(value, 10), 8)
    .option("--processors <number>", "Guest VM virtual processor count", (value) => Number.parseInt(value, 10), 4)
    .addOption(new Option("--generation <generation>", "Hyper-V VM generation")
      .choices(["1", "2"]).default("2"))
    .action(async (options) => {
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      process.once("SIGINT", onSigint);
      try {
        await runHyperVSandbox({
          url: options.url,
          name: options.name,
          labels: options.labels.split(","),
          templatePath: options.template,
          switchName: options.switch,
          sshUser: options.sshUser,
          sshKeyPath: options.sshKey,
          runnerDirectory: options.runnerDirectory,
          memoryGiB: options.memoryGib,
          processors: options.processors,
          generation: Number(options.generation) as 1 | 2,
          signal: controller.signal,
        });
        if (controller.signal.aborted) process.exitCode = 130;
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        process.off("SIGINT", onSigint);
      }
    });
}
