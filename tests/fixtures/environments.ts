import type { AuditEnvironment } from "../../src/contracts/config";
import type { RunExecution } from "../../src/contracts/result";

export const desktopEnvironment: AuditEnvironment = { name: "windows-chromium", platform: "windows", browser: "chromium", devices: [] };

export function withEnvironments(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  const references = Array.isArray(config.devices) ? config.devices.map((item) => item?.name).filter((name) => typeof name === "string") : [];
  return { environments: [{ ...desktopEnvironment, devices: references }], ...config };
}

export const executionFixture: RunExecution = { host: { platform: "linux", architecture: "x64", release: "fixture" }, engines: [], environments: [], devices: [] };
