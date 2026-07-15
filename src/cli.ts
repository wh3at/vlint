import { boundaryFailure, boundarySuccess } from "./contracts/failure";
import { runBrowserInstall } from "./commands/browser-install";
import { runCheckCommand } from "./commands/check";
import { CONFIG_NAME, runInitCommand, type InitResult } from "./commands/init";
import { runSetupCommand, type SetupResult } from "./commands/setup";
import {
  isDependenciesInstallerWorkerInvocation,
  isDependenciesSupervisorWorkerInvocation,
  isInstallerWorkerInvocation,
  isOopDownloaderInvocation,
  runDependenciesInstallerWorkerMain,
  runDependenciesSupervisorWorkerMain,
  runInstallerWorkerMain,
  runOopDownloaderMain,
} from "./browser/install";
import type { BoundaryResult } from "./contracts/failure";
import type { RunResultV2 } from "./contracts/result";
import { parseAdHocUrl } from "./config/schema";
import { renderJson } from "./output/json";
import { escapeTerminal, renderTerminal } from "./output/terminal";

export type OutputFormat = "terminal" | "json";

export type CliInvocation =
  | { readonly kind: "version" }
  | { readonly kind: "check"; readonly url: string | null; readonly format: OutputFormat }
  | { readonly kind: "browser-install"; readonly force: boolean; readonly withDeps: boolean }
  | { readonly kind: "init" }
  | { readonly kind: "setup" }
  | { readonly kind: "invalid"; readonly message: string };

export interface BrowserInstallResult {
  readonly revision: string;
  readonly action: "installed" | "already-present" | "reinstalled";
}

export interface CliRuntime {
  readonly version: string;
  check(url: string | null, signal?: AbortSignal): Promise<RunResultV2>;
  install(force: boolean, withDeps: boolean, signal?: AbortSignal): Promise<BoundaryResult<BrowserInstallResult>>;
  init(signal?: AbortSignal): Promise<BoundaryResult<InitResult>>;
  setup(signal?: AbortSignal): Promise<BoundaryResult<SetupResult>>;
}

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

function invalid(message: string): CliInvocation {
  return { kind: "invalid", message };
}

function unknownArgument(argument: string): CliInvocation {
  return invalid(`unknown argument: ${escapeTerminal(argument)}`);
}

export function parseCli(args: readonly string[]): CliInvocation {
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  if (args[0] === "check") {
    let url: string | null = null;
    let format: OutputFormat = "terminal";
    let sawFormat = false;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--url") {
        if (url !== null) return invalid("duplicate option: --url");
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) return invalid("--url requires a value");
        url = value;
        index += 1;
      } else if (argument === "--format") {
        if (sawFormat) return invalid("duplicate option: --format");
        const value = args[index + 1];
        if (value !== "terminal" && value !== "json") {
          return invalid("--format requires terminal or json");
        }
        format = value;
        sawFormat = true;
        index += 1;
      } else if (argument !== undefined) return unknownArgument(argument);
    }
    return { kind: "check", url, format };
  }
  if (args[0] === "browser" && args[1] === "install") {
    let force = false;
    let withDeps = false;
    for (const argument of args.slice(2)) {
      if (argument === "--force") {
        if (force) return invalid("duplicate option: --force");
        force = true;
      } else if (argument === "--with-deps") {
        if (withDeps) return invalid("duplicate option: --with-deps");
        withDeps = true;
      } else {
        return unknownArgument(argument);
      }
    }
    return { kind: "browser-install", force, withDeps };
  }
  if (args[0] === "init") {
    if (args.length !== 1) return unknownArgument(args[1] ?? "");
    return { kind: "init" };
  }
  if (args[0] === "setup") {
    if (args.length !== 1) return unknownArgument(args[1] ?? "");
    return { kind: "setup" };
  }
  return unknownArgument(args[0] ?? "");
}

export async function runCli(
  args: readonly string[],
  runtime: CliRuntime,
  io: CliIo,
  signal?: AbortSignal,
): Promise<0 | 1 | 2> {
  const invocation = parseCli(args);
  if (invocation.kind === "invalid") {
    io.stderr(`vlint: invalid-arguments: ${invocation.message}\n`);
    return 2;
  }
  if (invocation.kind === "version") {
    io.stdout(`vlint ${escapeTerminal(runtime.version)}\n`);
    return 0;
  }
  if (invocation.kind === "browser-install") {
    const installed = await runtime.install(invocation.force, invocation.withDeps, signal);
    if (!installed.ok) {
      io.stderr(
        `vlint: ${installed.failure.code}: ${escapeTerminal(installed.failure.message)}\n`,
      );
      return 2;
    }
    io.stdout(
      `vlint browser: chromium ${escapeTerminal(installed.value.revision)} ready (${installed.value.action})\n`,
    );
    return 0;
  }
  if (invocation.kind === "init") {
    const initialized = await runtime.init(signal);
    if (!initialized.ok) {
      io.stderr(`vlint: ${initialized.failure.code}: ${escapeTerminal(initialized.failure.message)}\n`);
      return 2;
    }
    io.stdout(`vlint init: created ${CONFIG_NAME}\n`);
    return 0;
  }
  if (invocation.kind === "setup") {
    const setup = await runtime.setup(signal);
    if (!setup.ok) {
      io.stderr(`vlint: ${setup.failure.code}: ${escapeTerminal(setup.failure.message)}\n`);
      return 2;
    }
    const action = setup.value.browser.kind === "repaired"
      ? "reinstalled"
      : setup.value.browser.kind;
    io.stdout(
      `vlint setup: config ${setup.value.config}; chromium ${escapeTerminal(setup.value.browser.browser.revision)} ready (${action})\n`,
    );
    return 0;
  }
  if (invocation.url !== null) {
    const parsedUrl = parseAdHocUrl(invocation.url);
    if (!parsedUrl.ok) {
      io.stderr(`vlint: invalid-arguments: ${escapeTerminal(parsedUrl.failure.message)}\n`);
      return 2;
    }
  }
  const result = await runtime.check(invocation.url, signal);
  io.stdout(invocation.format === "json" ? renderJson(result) : renderTerminal(result));
  if (result.status === "incomplete") return 2;
  return result.status === "violations" ? 1 : 0;
}

declare const __VLINT_VERSION__: string;
const TOOL_VERSION =
  typeof __VLINT_VERSION__ === "string" ? __VLINT_VERSION__ : "0.2.0";

const productionRuntime: CliRuntime = {
  version: TOOL_VERSION,
  check: (url, signal) =>
    runCheckCommand(process.cwd(), url, process.env, TOOL_VERSION, signal),
  init: (signal) => runInitCommand(process.cwd(), signal),
  setup: (signal) => runSetupCommand(process.cwd(), process.env, signal),
  async install(force, withDeps, signal) {
    const args = [
      ...(force ? ["--force"] : []),
      ...(withDeps ? ["--with-deps"] : []),
    ];
    const command = await runBrowserInstall({
      args,
      environment: process.env,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!command.ok) return boundaryFailure(command.failure);
    const action =
      command.outcome.kind === "repaired" ? "reinstalled" : command.outcome.kind;
    return boundarySuccess({
      revision: command.outcome.browser.revision,
      action,
    });
  },
};

async function runProductionCli(): Promise<0 | 1 | 2> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await runCli(
      process.argv.slice(2),
      productionRuntime,
      {
        stdout: (value) => process.stdout.write(value),
        stderr: (value) => process.stderr.write(value),
      },
      controller.signal,
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  if (isDependenciesSupervisorWorkerInvocation(process.argv)) {
    await runDependenciesSupervisorWorkerMain();
  } else if (isDependenciesInstallerWorkerInvocation(process.argv)) {
    await runDependenciesInstallerWorkerMain();
  } else if (isInstallerWorkerInvocation(process.argv)) {
    await runInstallerWorkerMain(process.argv);
  } else if (process.argv.some((argument) => isOopDownloaderInvocation(argument))) {
    runOopDownloaderMain();
  } else {
    process.exitCode = await runProductionCli();
  }
}
