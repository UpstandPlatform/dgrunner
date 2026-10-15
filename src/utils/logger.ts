import pc from "picocolors";

export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 6) return "******";
  return `${"*".repeat(Math.min(token.length - 4, 12))}${token.slice(-4)}`;
}

export const logger = {
  header(title: string): void {
    console.log();
    console.log(pc.bold(pc.cyan(`=== ${title} ===`)));
    console.log();
  },

  info(msg: string): void {
    console.log(pc.blue("ℹ ") + msg);
  },

  success(msg: string): void {
    console.log(pc.green("✔ ") + pc.bold(msg));
  },

  warn(msg: string): void {
    console.log(pc.yellow("⚠ ") + pc.yellow(msg));
  },

  error(msg: string): void {
    console.error(pc.red("✖ ") + pc.red(pc.bold(msg)));
  },

  step(current: number, total: number, msg: string): void {
    console.log(pc.magenta(`[${current}/${total}] `) + pc.bold(msg));
  },

  dim(msg: string): void {
    console.log(pc.dim(msg));
  },

  box(title: string, lines: string[], borderColor: "cyan" | "green" | "yellow" | "red" = "cyan"): void {
    const colorFn = pc[borderColor] || pc.cyan;
    const maxLen = Math.max(title.length + 4, ...lines.map((l) => l.length)) + 4;
    const border = "─".repeat(maxLen);

    console.log();
    console.log(colorFn(`┌─ ${pc.bold(title)} ${"─".repeat(Math.max(0, maxLen - title.length - 4))}┐`));
    for (const line of lines) {
      const padding = " ".repeat(Math.max(0, maxLen - line.length - 2));
      console.log(colorFn("│ ") + line + padding + colorFn("│"));
    }
    console.log(colorFn(`└${border}┘`));
    console.log();
  },

  securityAlert(msg: string): void {
    console.log();
    console.log(pc.bgRed(pc.white(pc.bold(" SECURITY ALERT "))));
    console.log(pc.red(msg));
    console.log();
  },
};
