import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { devices as playwrightDevices } from "playwright";
import type { ConfigV2, DeviceProfile, Viewport } from "../contracts/config";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
} from "../contracts/failure";

export const CONFIG_NAME = "vlint.config.json";

export interface InitResult {
  readonly path: string;
}

const IPHONE_KEY = "iPhone 17";
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}


/**
 * Standard desktop device: MacBook Air 13" (M5) default logical display.
 * `userAgent` is omitted so Playwright's Chromium default user agent is used.
 */
const MACBOOK_PROFILE: DeviceProfile = {
  name: "macbook-air-13-m5",
  viewport: { width: 1470, height: 956 },
  screen: { width: 1470, height: 956 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
};

/** Standard rules pinned into generated configuration. */
const STANDARD_RULES = [
  {
    name: "tab-label-single-line",
    type: "tab-label-single-line",
  },
  {
    name: "page-horizontal-overflow",
    type: "page-horizontal-overflow",
  },
] as const;

/**
 * Minimal registry shape used to source the iPhone descriptor. The real
 * Playwright `devices` object is the default source; tests inject a controlled
 * shape to exercise the missing/invalid descriptor path.
 */
export type DeviceSource = Readonly<Record<string, unknown>>;

interface IphoneDescriptor {
  readonly userAgent: string;
  readonly viewport: Viewport;
  readonly screen: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asViewport(value: unknown): Viewport | null {
  if (!isRecord(value)) return null;
  const width = value.width;
  const height = value.height;
  if (typeof width !== "number" || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return { width, height };
}

/**
 * Project-owned runtime refinement of the iPhone 17 descriptor.
 *
 * The public Playwright `DeviceDescriptor` type omits `screen`, so the registry
 * value is treated as `unknown` and the full context-relevant shape — including
 * `screen` — is validated here. A missing key or any missing/invalid field
 * becomes a typed init failure rather than a silent approximation. No internal
 * Playwright import and no unchecked cast is used: the value flows through
 * `unknown` and narrows via guards.
 */
function refineIphone(descriptor: unknown): IphoneDescriptor | null {
  if (!isRecord(descriptor)) return null;
  const screen = asViewport(descriptor.screen);
  const viewport = asViewport(descriptor.viewport);
  if (screen === null || viewport === null) return null;
  const userAgent = descriptor.userAgent;
  const deviceScaleFactor = descriptor.deviceScaleFactor;
  const isMobile = descriptor.isMobile;
  const hasTouch = descriptor.hasTouch;
  if (typeof userAgent !== "string" || userAgent.length === 0) return null;
  if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor)) return null;
  if (typeof isMobile !== "boolean" || typeof hasTouch !== "boolean") return null;
  return { userAgent, viewport, screen, deviceScaleFactor, isMobile, hasTouch };
}

/**
 * Build the standard version 2 config: the two standard devices and rules, with
 * no provider and no URL. The iPhone profile is normalized from the Playwright
 * registry into concrete values at generation time; the Chromium-incompatible
 * `defaultBrowserType` is deliberately dropped.
 */
export function buildStandardConfig(source: DeviceSource = playwrightDevices): BoundaryResult<ConfigV2> {
  const raw = source[IPHONE_KEY];
  if (raw === undefined) {
    return boundaryFailure({
      stage: "config",
      code: "init-device-unavailable",
      message: `Playwright registry does not provide ${IPHONE_KEY}`,
      target: null,
      device: null,
      rule: null,
    });
  }
  const iphone = refineIphone(raw);
  if (iphone === null) {
    return boundaryFailure({
      stage: "config",
      code: "init-device-unavailable",
      message: `Playwright ${IPHONE_KEY} descriptor is missing required emulation fields`,
      target: null,
      device: null,
      rule: null,
    });
  }
  const iphoneProfile: DeviceProfile = {
    name: "iphone-17",
    viewport: iphone.viewport,
    screen: iphone.screen,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: iphone.isMobile,
    hasTouch: iphone.hasTouch,
    userAgent: iphone.userAgent,
  };
  return boundarySuccess({
    schemaVersion: 2,
    devices: [MACBOOK_PROFILE, iphoneProfile],
    rules: STANDARD_RULES,
  });
}

/**
 * Run `vlint init` against a directory. Generates the standard config via an
 * exclusive create (O_CREAT|O_EXCL) so an existing regular file, directory, or
 * symlink target is never overwritten, then writes a single stable byte stream.
 * Returns the created path on success or a typed failure otherwise.
 */
export async function runInitCommand(
  cwd: string,
  signal?: AbortSignal,
): Promise<BoundaryResult<InitResult>> {
  if (signalAborted(signal)) {
    return boundaryFailure({
      stage: "interrupt",
      code: "signal-interrupt",
      message: "operation cancelled",
      target: null,
      device: null,
      rule: null,
    });
  }
  const config = buildStandardConfig();
  if (!config.ok) return config;
  const path = resolve(cwd, CONFIG_NAME);
  const content = `${JSON.stringify(config.value, null, 2)}\n`;

  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    // EEXIST: a regular file or a symlink whose target already exists.
    // EISDIR: the path is an existing directory. Both mean the path is taken.
    if (code === "EEXIST" || code === "EISDIR") {
      return boundaryFailure({
        stage: "config",
        code: "config-already-exists",
        message: `${CONFIG_NAME} already exists`,
        target: null,
        device: null,
        rule: null,
      });
    }
    return boundaryFailure({
      stage: "config",
      code: "config-write-failed",
      message: `cannot create ${CONFIG_NAME}`,
      target: null,
      device: null,
      rule: null,
    });
  }
  let committed = false;
  try {
    if (signalAborted(signal)) {
      return boundaryFailure({
        stage: "interrupt",
        code: "signal-interrupt",
        message: "operation cancelled",
        target: null,
        device: null,
        rule: null,
      });
    }
    await handle.writeFile(content, "utf8");
    if (signalAborted(signal)) {
      return boundaryFailure({
        stage: "interrupt",
        code: "signal-interrupt",
        message: "operation cancelled",
        target: null,
        device: null,
        rule: null,
      });
    }
    committed = true;
    return boundarySuccess({ path });
  } catch {
    return boundaryFailure({
      stage: "config",
      code: "config-write-failed",
      message: `cannot write ${CONFIG_NAME}`,
      target: null,
      device: null,
      rule: null,
    });
  } finally {
    await handle.close().catch(() => undefined);
    if (!committed) await unlink(path).catch(() => undefined);
  }
}
