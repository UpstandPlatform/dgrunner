import { describe, it, expect } from "vitest";
import { isInsecureRemoteDockerHost, validateGitHubUrl, validateRegistrationToken } from "../src/core/security.js";
import { maskToken } from "../src/utils/logger.js";

describe("Security Module", () => {
  describe("validateGitHubUrl", () => {
    it("should accept valid repository HTTPS URLs", () => {
      const res = validateGitHubUrl("https://github.com/my-org/my-private-repo");
      expect(res.valid).toBe(true);
      expect(res.scope).toBe("repo");
    });

    it("should accept valid organization HTTPS URLs", () => {
      const res = validateGitHubUrl("https://github.com/my-org");
      expect(res.valid).toBe(true);
      expect(res.scope).toBe("org");
    });

    it("should reject non-HTTPS URLs", () => {
      const res = validateGitHubUrl("http://github.com/owner/repo");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("HTTPS");
    });

    it("should reject non-GitHub domains", () => {
      const res = validateGitHubUrl("https://evil-site.com/owner/repo");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("github.com");
    });

    it("should reject empty or malformed URLs", () => {
      expect(validateGitHubUrl("").valid).toBe(false);
      expect(validateGitHubUrl("not-a-url").valid).toBe(false);
    });

    it("should reject GitHub lookalike URLs and URL fields that could redirect registration", () => {
      for (const url of [
        "https://github.com.evil.example/owner/repo",
        "https://user:password@github.com/owner/repo",
        "https://github.com:8443/owner/repo",
        "https://github.com/owner/repo?next=https://evil.example",
        "https://github.com/owner/%2e%2e/repo",
      ]) {
        expect(validateGitHubUrl(url).valid, url).toBe(false);
      }
    });
  });

  describe("isInsecureRemoteDockerHost", () => {
    it("flags remote TCP hosts but permits loopback and verified TLS", () => {
      expect(isInsecureRemoteDockerHost("tcp://192.0.2.10:2375")).toBe(true);
      expect(isInsecureRemoteDockerHost("tcp://localhost:2375")).toBe(false);
      expect(isInsecureRemoteDockerHost("tcp://127.0.0.2:2375")).toBe(false);
      expect(isInsecureRemoteDockerHost("tcp://[::1]:2375")).toBe(false);
      expect(isInsecureRemoteDockerHost("tcp://localhost.evil.example:2375")).toBe(true);
      expect(isInsecureRemoteDockerHost("tcp://docker.example:2376", "1")).toBe(false);
    });
  });

  describe("validateRegistrationToken", () => {
    it("should accept standard GitHub Actions registration tokens", () => {
      const res = validateRegistrationToken("AB12CD34EF56GH78IJ90KLMN");
      expect(res.valid).toBe(true);
    });

    it("should reject suspiciously short tokens", () => {
      const res = validateRegistrationToken("short");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("too short");
    });

    it("should reject tokens containing whitespace or newline characters", () => {
      const res = validateRegistrationToken("AB12CD34EF 56GH78IJ90");
      expect(res.valid).toBe(false);
      expect(res.error).toContain("whitespace");
    });
  });

  describe("maskToken", () => {
    it("should mask sensitive characters in tokens preserving only the tail", () => {
      const masked = maskToken("AB12CD34EF56GH78IJ90");
      expect(masked.endsWith("IJ90")).toBe(true);
      expect(masked.startsWith("************")).toBe(true);
      expect(masked).not.toContain("AB12CD");
    });

    it("should handle empty or very short strings gracefully", () => {
      expect(maskToken("")).toBe("");
      expect(maskToken("12345")).toBe("******");
    });
  });
});
