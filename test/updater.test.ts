import { describe, it, expect } from "vitest";
import {
  compareSemver,
  getUpgradeCommand,
  detectPackageManager,
  fetchLatestVersion,
} from "../src/core/updater.js";

describe("Updater Module", () => {
  describe("compareSemver", () => {
    it("should correctly compare identical versions", () => {
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("2.14.3", "v2.14.3")).toBe(0);
    });

    it("should correctly determine when v1 is newer than v2", () => {
      expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
      expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
      expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
      expect(compareSemver("v1.0.1", "1.0.0")).toBe(1);
    });

    it("should correctly determine when v1 is older than v2", () => {
      expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
      expect(compareSemver("1.0.9", "1.1.0")).toBe(-1);
      expect(compareSemver("1.9.0", "2.0.0")).toBe(-1);
    });

    it("should handle pre-release tags properly", () => {
      expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
      expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
    });
  });

  describe("getUpgradeCommand", () => {
    it("should generate proper npm command", () => {
      const res = getUpgradeCommand("npm");
      expect(res.command).toBe("npm");
      expect(res.args).toEqual(["install", "-g", "@upstand/dgrunner@latest"]);
      expect(res.display).toBe("npm install -g @upstand/dgrunner@latest");
    });

    it("should generate proper pnpm command", () => {
      const res = getUpgradeCommand("pnpm");
      expect(res.command).toBe("pnpm");
      expect(res.args).toEqual(["add", "-g", "@upstand/dgrunner@latest"]);
    });

    it("should generate proper yarn command", () => {
      const res = getUpgradeCommand("yarn");
      expect(res.command).toBe("yarn");
      expect(res.args).toEqual(["global", "add", "@upstand/dgrunner@latest"]);
    });

    it("should generate proper bun command", () => {
      const res = getUpgradeCommand("bun");
      expect(res.command).toBe("bun");
      expect(res.args).toEqual(["add", "-g", "@upstand/dgrunner@latest"]);
    });

    it("should support custom distribution tags", () => {
      const res = getUpgradeCommand("npm", "next");
      expect(res.args).toEqual(["install", "-g", "@upstand/dgrunner@next"]);
    });
  });

  describe("detectPackageManager", () => {
    it("should default to a valid package manager", () => {
      const pm = detectPackageManager();
      expect(["npm", "pnpm", "yarn", "bun"]).toContain(pm);
    });
  });

  describe("fetchLatestVersion", () => {
    it("should fetch latest version from npm registry or fallback", async () => {
      const ver = await fetchLatestVersion("latest");
      if (ver) {
        expect(ver).toMatch(/^\d+\.\d+\.\d+/);
      }
    });
  });
});
