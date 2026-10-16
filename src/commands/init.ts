import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { devices as playwrightDevices } from "playwright";
import type { Config, DeviceProfile, AuditEnvironment } from "../contracts/config";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type FailureCode } from "../contracts/failure";

export const CONFIG_NAME = "vlint.config.json";
export interface InitResult { readonly path: string }
export type DeviceSource = Readonly<Record<string, unknown>>;

const PRESETS = {
  "windows:chromium": "Desktop Chrome",
  "windows:firefox": "Desktop Firefox",
  "macos:chromium": "Desktop Chrome",
  "macos:webkit": "Desktop Safari",
  "iphone:webkit": "iPhone 17",
  "android:chromium": "Pixel 10",
} as const;
export const ENVIRONMENT_CHOICES = Object.keys(PRESETS);

function failure(code: FailureCode, message: string): BoundaryResult<never> {
  return boundaryFailure({ stage: code === "signal-interrupt" ? "interrupt" : "config", code, message, target: null, device: null, rule: null });
}

function viewport(value: unknown): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null) return false;
  return "width" in value && typeof value.width === "number" && value.width > 0 && Number.isFinite(value.width)
    && "height" in value && typeof value.height === "number" && value.height > 0 && Number.isFinite(value.height);
}

export function buildStandardConfig(selections: readonly string[], source: DeviceSource = playwrightDevices): BoundaryResult<Config> {
  if (selections.length === 0) return failure("init-environment-required", "Choose environments with --environment windows:chromium; see vlint init --help");
  const devices: DeviceProfile[] = [];
  const environments: AuditEnvironment[] = [];
  for (const selection of new Set(selections)) {
    if (!Object.hasOwn(PRESETS, selection)) return failure("init-environment-invalid", `Unsupported environment ${selection}; see vlint init --help`);
    const key = selection as keyof typeof PRESETS;
    const preset = PRESETS[key];
    const descriptor = source[preset];
    if (typeof descriptor !== "object" || descriptor === null
      || !("viewport" in descriptor) || !viewport(descriptor.viewport)
      || !("screen" in descriptor) || !viewport(descriptor.screen)
      || !("deviceScaleFactor" in descriptor) || typeof descriptor.deviceScaleFactor !== "number" || !Number.isFinite(descriptor.deviceScaleFactor) || descriptor.deviceScaleFactor <= 0
      || !("isMobile" in descriptor) || typeof descriptor.isMobile !== "boolean"
      || !("hasTouch" in descriptor) || typeof descriptor.hasTouch !== "boolean") {
      return failure("init-device-unavailable", `Playwright ${preset} descriptor is missing required emulation fields`);
    }
    const name = key.replace(":", "-");
    const [platform, browser] = key.split(":") as [AuditEnvironment["platform"], AuditEnvironment["browser"]];
    devices.push({ name, viewport: descriptor.viewport, screen: descriptor.screen, deviceScaleFactor: descriptor.deviceScaleFactor, isMobile: descriptor.isMobile, hasTouch: descriptor.hasTouch });
    environments.push({ name, platform, browser, devices: [name] });
  }
  return boundarySuccess({ devices, environments, rules: [
    { name: "tab-label-single-line", type: "tab-label-single-line" },
    { name: "page-horizontal-overflow", type: "page-horizontal-overflow" },
    { name: "table-header-single-line", type: "table-header-single-line" },
    { name: "table-cell-text-overlap", type: "table-cell-text-overlap" },
    { name: "svg-text-clipping", type: "svg-text-clipping" },
  ] });
}

async function interactiveSelections(signal?: AbortSignal): Promise<readonly string[]> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const selections: string[] = [];
  try {
    while (true) {
      const platform = (await terminal.question("Platform (windows, macos, iphone, android; done to finish): ", { signal })).trim();
      if (platform === "done" && selections.length > 0) return selections;
      const choices = ENVIRONMENT_CHOICES.filter((choice) => choice.startsWith(`${platform}:`));
      if (choices.length === 0) { process.stdout.write("Choose a listed platform.\n"); continue; }
      const browser = (await terminal.question(`Browser (${choices.map((choice) => choice.split(":")[1]).join(", ")}): `, { signal })).trim();
      const selection = `${platform}:${browser}`;
      if (!choices.includes(selection)) { process.stdout.write("Choose a listed browser.\n"); continue; }
      selections.push(selection);
    }
  } finally { terminal.close(); }
}

export async function runInitCommand(cwd: string, signal?: AbortSignal, selections: readonly string[] = []): Promise<BoundaryResult<InitResult>> {
  if (signal?.aborted) return failure("signal-interrupt", "operation cancelled");
  let chosen = selections;
  if (chosen.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    try { chosen = await interactiveSelections(signal); }
    catch { return signal?.aborted ? failure("signal-interrupt", "operation cancelled") : failure("init-environment-required", "Environment selection ended; see vlint init --help"); }
  }
  const config = buildStandardConfig(chosen);
  if (!config.ok) return config;
  const path = resolve(cwd, CONFIG_NAME);
  let handle;
  try { handle = await open(path, "wx"); }
  catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    return code === "EEXIST" || code === "EISDIR"
      ? failure("config-already-exists", `${CONFIG_NAME} already exists`)
      : failure("config-write-failed", `cannot create ${CONFIG_NAME}`);
  }
  let committed = false;
  try {
    if (signal?.aborted) return failure("signal-interrupt", "operation cancelled");
    await handle.writeFile(`${JSON.stringify(config.value, null, 2)}\n`, "utf8");
    if (signal?.aborted) return failure("signal-interrupt", "operation cancelled");
    committed = true;
    return boundarySuccess({ path });
  } catch { return failure("config-write-failed", `cannot write ${CONFIG_NAME}`); }
  finally {
    await handle.close().catch(() => undefined);
    if (!committed) await unlink(path).catch(() => undefined);
  }
}
