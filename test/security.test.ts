import { describe, it, expect } from "vitest";
import { validateGitHubUrl, validateRegistrationToken } from "../src/core/security.js";
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
