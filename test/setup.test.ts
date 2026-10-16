import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerSetupCommand } from "../src/commands/setup.js";

describe("Setup command options", () => {
  it("keeps background startup enabled unless --no-service is supplied", () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((command) => command.name() === "setup");
    const serviceOption = setup?.options.find((option) => option.long === "--no-service");

    expect(serviceOption).toBeDefined();
    expect(serviceOption?.defaultValue).toBeUndefined();
  });

  it("restricts --env to supported runner environments", () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((command) => command.name() === "setup");
    const environmentOption = setup?.options.find((option) => option.long === "--env");

    expect(environmentOption?.argChoices).toEqual(["windows", "docker", "wsl", "native"]);
  });

  it("exposes an explicit Docker container name for multi-runner setup", () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((command) => command.name() === "setup");
    const containerNameOption = setup?.options.find((option) => option.long === "--container-name");

    expect(containerNameOption).toBeDefined();
  });

  it("rejects an invalid --env value during CLI parsing", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerSetupCommand(program);

    await expect(program.parseAsync(["node", "dgrunner", "setup", "--env", "dockr"]))
      .rejects.toThrow();
  });
});
