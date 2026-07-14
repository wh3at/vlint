import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import {
  installBrowser,
  type EnvironmentView,
  type InstallOutcome,
} from "../browser/install";

export interface BrowserInstallCommandOptions {
  readonly args: readonly string[];
  readonly environment?: EnvironmentView;
  readonly signal?: AbortSignal;
}

export type BrowserInstallCommandResult =
  | { readonly ok: true; readonly outcome: InstallOutcome }
  | { readonly ok: false; readonly failure: Failure };

/** Parses `vlint browser install [--force]`. Unknown arguments are rejected. */
export function parseBrowserInstallArgs(args: readonly string[]): BoundaryResult<{ readonly force: boolean }> {
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length > 0) {
    return boundaryFailure({
      stage: "config",
      code: "config-schema-invalid",
      message: "unknown argument to 'vlint browser install'; only --force is accepted",
      target: null,
      rule: null,
    });
  }
  return boundarySuccess({ force: args.includes("--force") });
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
      failure: { stage: "interrupt", code: "signal-interrupt", message: "operation cancelled", target: null, rule: null },
    };
  }
  const result = await installBrowser(
    options.environment === undefined
      ? { force: parsed.value.force }
      : { force: parsed.value.force, environment: options.environment },
  );
  if (!result.ok) return { ok: false, failure: result.failure };
  return { ok: true, outcome: result.value };
}
