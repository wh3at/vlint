import { devices } from "playwright";
import type { AuditEnvironment } from "../contracts/config";
import { managedExecutable } from "./management";

export function environmentUserAgent(environment: AuditEnvironment): string {
  if (environment.platform === "macos" && environment.browser === "chromium") {
    const version = managedExecutable("chromium").browserVersion;
    if (version === undefined) throw new Error("managed Chromium version is unavailable");
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
  const name = environment.platform === "windows" ? environment.browser === "firefox" ? "Desktop Firefox" : "Desktop Chrome"
    : environment.platform === "macos" ? "Desktop Safari" : environment.platform === "iphone" ? "iPhone 17" : "Pixel 10";
  const preset = devices[name];
  if (!preset?.userAgent) throw new Error(`required Playwright preset is unavailable: ${name}`);
  return preset.userAgent;
}
