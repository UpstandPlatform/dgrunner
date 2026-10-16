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
});
