import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installBrowser,
  type EnvironmentView,
  type InstallOptions,
  type InstallOutcome,
} from "../browser/install";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
} from "../contracts/failure";
import { loadConfig } from "../config/load";
import { CONFIG_NAME, runInitCommand } from "./init";

export type SetupBrowserInstaller = (
  options: InstallOptions,
) => Promise<BoundaryResult<InstallOutcome>>;

export interface SetupResult {
  readonly config: "created" | "already-present";
  readonly browser: InstallOutcome;
}

export async function runSetupCommand(
  cwd: string,
  environment: EnvironmentView = process.env,
  signal?: AbortSignal,
  browserInstaller: SetupBrowserInstaller = installBrowser,
): Promise<BoundaryResult<SetupResult>> {
  const configPath = resolve(cwd, CONFIG_NAME);
  let config: SetupResult["config"];

  try {
    const stat = await lstat(configPath);
    if (!stat.isFile()) {
      return boundaryFailure({
        stage: "config",
        code: "config-read-failed",
        message: `${CONFIG_NAME} is not a regular file`,
        target: null,
        device: null,
        rule: null,
      });
    }
    const loaded = await loadConfig(cwd);
    if (!loaded.ok) return boundaryFailure(loaded.failure);
    config = "already-present";
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (code !== "ENOENT") {
      return boundaryFailure({
        stage: "config",
        code: "config-read-failed",
        message: `cannot inspect ${CONFIG_NAME}`,
        target: null,
        device: null,
        rule: null,
      });
    }
    const initialized = await runInitCommand(cwd, signal);
    if (!initialized.ok) return boundaryFailure(initialized.failure);
    config = "created";
  }

  const browser = await browserInstaller({
    force: false,
    environment,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!browser.ok) return boundaryFailure(browser.failure);
  return boundarySuccess({ config, browser: browser.value });
}
