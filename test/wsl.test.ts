import { describe, it, expect } from "vitest";
import {
  isWsl,
  detectLinuxDistro,
  parseInstalledWslDistroDetails,
  getInstalledWslDistros,
  getAvailableOnlineWslDistros,
} from "../src/core/wsl.js";

describe("WSL & Linux Distro Module", () => {
  it("should determine if running in WSL", () => {
    const wsl = isWsl();
    expect(typeof wsl).toBe("boolean");
  });

  it("should detect Linux distro safely on current platform", async () => {
    const distro = await detectLinuxDistro();
    if (process.platform === "linux") {
      // On Linux, distro might be null or LinuxDistroInfo
      if (distro) {
        expect(distro).toHaveProperty("id");
        expect(distro).toHaveProperty("name");
      }
    } else {
      expect(distro).toBeNull();
    }
  });

  it("should list installed WSL distros on Windows without error", async () => {
    const distros = await getInstalledWslDistros();
    expect(Array.isArray(distros)).toBe(true);
    // If docker-desktop is present on machine, verify it is filtered out
    for (const d of distros) {
      expect(d.toLowerCase()).not.toContain("docker-desktop");
    }
  });

  it("should list available online WSL distros on Windows", async () => {
    const online = await getAvailableOnlineWslDistros();
    expect(Array.isArray(online)).toBe(true);
    if (process.platform === "win32") {
      expect(online.length).toBeGreaterThan(0);
      expect(online.some((d) => d.toLowerCase().includes("ubuntu"))).toBe(true);
    }
  });

  it("parses WSL distro versions and ignores Docker Desktop internal distros", () => {
    const distros = parseInstalledWslDistroDetails(
      "  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  Debian                 Stopped         1\r\n  docker-desktop         Stopped         2\r\n"
    );

    expect(distros).toEqual([
      { name: "Ubuntu-24.04", state: "Running", version: 2 },
      { name: "Debian", state: "Stopped", version: 1 },
    ]);
  });
});
