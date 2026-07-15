import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import {
  installBrowser,
  installBrowserDependencies,
  rejectAmbientBrowserOverrides,
  type EnvironmentView,
  type InstallDependenciesOptions,
  type InstallOptions,
  type InstallOutcome,
} from "../browser/install";

export interface BrowserInstallCommandOptions {
  readonly args: readonly string[];
  readonly environment?: EnvironmentView;
  readonly signal?: AbortSignal;
  /** Test-only seams for the privileged dependency step and browser payload. */
  readonly dependenciesInstaller?: (
    options: InstallDependenciesOptions,
  ) => Promise<BoundaryResult<void>>;
  readonly browserInstaller?: (
    options: InstallOptions,
  ) => Promise<BoundaryResult<InstallOutcome>>;
}

export type BrowserInstallCommandResult =
  | { readonly ok: true; readonly outcome: InstallOutcome }
  | { readonly ok: false; readonly failure: Failure };

/** Parses `vlint browser install [--force] [--with-deps]`. */
export function parseBrowserInstallArgs(
  args: readonly string[],
): BoundaryResult<{ readonly force: boolean; readonly withDeps: boolean }> {
  let force = false;
  let withDeps = false;
  for (const argument of args) {
    if (argument === "--force") {
      if (force) {
        return boundaryFailure({
          stage: "config", code: "config-schema-invalid", message: "duplicate option: --force",
          target: null, device: null, rule: null,
        });
      }
      force = true;
    } else if (argument === "--with-deps") {
      if (withDeps) {
        return boundaryFailure({
          stage: "config", code: "config-schema-invalid", message: "duplicate option: --with-deps",
          target: null, device: null, rule: null,
        });
      }
      withDeps = true;
    } else {
      return boundaryFailure({
        stage: "config",
        code: "config-schema-invalid",
        message: `unknown argument to 'vlint browser install': ${argument}`,
        target: null,
        device: null,
        rule: null,
      });
    }
  }
  return boundarySuccess({ force, withDeps });
}

/**
 * Runs the `vlint browser install` command. Downloads only via this command —
 * never during `vlint check`. Ambient cache/download-host overrides are rejected
 * before installer access inside the adapter. Returns a classified outcome or a
 * sanitized typed failure; raw exceptions and installer sentinels never escape.
 */
export async function runBrowserInstall(
  options: BrowserInstallCommandOptions,
): Promise<BrowserInstallCommandResult> {
  const parsed = parseBrowserInstallArgs(options.args);
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  if (options.signal?.aborted === true) {
    return {
      ok: false,
      failure: { stage: "interrupt", code: "signal-interrupt", message: "operation cancelled", target: null, device: null, rule: null },
    };
  }
  const environment = rejectAmbientBrowserOverrides("install", options.environment);
  if (!environment.ok) return { ok: false, failure: environment.failure };
  if (parsed.value.withDeps) {
    const dependencies = await (options.dependenciesInstaller ?? installBrowserDependencies)({
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!dependencies.ok) return { ok: false, failure: dependencies.failure };
  }
  const result = await (options.browserInstaller ?? installBrowser)({
    force: parsed.value.force,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  return { ok: true, outcome: result.value };
}
