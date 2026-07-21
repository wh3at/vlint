import { Command, CommanderError, Option } from "commander";
import { boundaryFailure, boundarySuccess } from "./contracts/failure";
import { runBrowserInstall } from "./commands/browser-install";
import { runBrowserStatus, type BrowserStatusOutput } from "./commands/browser-status";
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
import type { RunResultV3 } from "./contracts/result";
import { parseAdHocUrl } from "./config/schema";
import { renderJson } from "./output/json";
import { escapeTerminal, redactUrlForTerminal, renderTerminal } from "./output/terminal";

export type OutputFormat = "terminal" | "json";

export type CliInvocation =
  | { readonly kind: "check"; readonly url: string | null; readonly format: OutputFormat }
  | { readonly kind: "browser-install"; readonly force: boolean; readonly withDeps: boolean }
  | { readonly kind: "browser-status"; readonly format: OutputFormat }
  | { readonly kind: "init" }
  | { readonly kind: "setup" };

export type CliParseResult =
  | { readonly kind: "invocation"; readonly invocation: CliInvocation }
  | {
      readonly kind: "terminal";
      readonly exitCode: 0 | 1;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface BrowserInstallResult {
  readonly revision: string;
  readonly action: "installed" | "already-present" | "reinstalled";
}

export interface CliRuntime {
  readonly version: string;
  check(url: string | null, signal?: AbortSignal): Promise<RunResultV3>;
  install(force: boolean, withDeps: boolean, signal?: AbortSignal): Promise<BoundaryResult<BrowserInstallResult>>;
  status(format: "terminal" | "json", signal?: AbortSignal): Promise<BoundaryResult<BrowserStatusOutput>>;
  init(signal?: AbortSignal): Promise<BoundaryResult<InitResult>>;
  setup(signal?: AbortSignal): Promise<BoundaryResult<SetupResult>>;
}

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const HELP_FLAGS = new Set(["-h", "--help"]);
const HELP_WIDTH = 80;

function unsafeArgument(argument: string): boolean {
  return escapeTerminal(argument) !== argument;
}

function diagnosticArgument(argument: string): string {
  const redactedArgument = redactUrlForTerminal(argument);
  if (redactedArgument !== argument) return redactedArgument;
  const separator = argument.startsWith("-") ? argument.indexOf("=") : -1;
  if (separator > 0) {
    const prefix = argument.slice(0, separator + 1);
    const value = argument.slice(separator + 1);
    const redactedValue = redactUrlForTerminal(value);
    return redactedValue === value ? escapeTerminal(argument) : `${prefix}${redactedValue}`;
  }
  return escapeTerminal(argument);
}

function sanitizeCommanderError(value: string, args: readonly string[]): string {
  let sanitized = value;
  for (const argument of args) {
    if (argument.length === 0) continue;
    const replacement = diagnosticArgument(argument);
    if (replacement !== argument) sanitized = sanitized.replaceAll(argument, replacement);
  }
  return sanitized;
}

function helpFlagIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return -1;
    if (argument !== undefined && HELP_FLAGS.has(argument)) return index;
  }
  return -1;
}

function resolveHelpScope(root: Command, args: readonly string[], helpIndex: number): Command {
  let command = root;
  let commandPathBlocked = false;
  for (let index = 0; index < helpIndex; index += 1) {
    const argument = args[index];
    if (argument === undefined || argument.startsWith("-") || commandPathBlocked) continue;
    const child = command.commands.find(
      (candidate) => candidate.name() === argument || candidate.aliases().includes(argument),
    );
    if (child !== undefined) command = child;
    else if (command.commands.length > 0) commandPathBlocked = true;
  }
  return command;
}

function buildCliProgram(version: string, rawArgs: readonly string[]): {
  readonly program: Command;
  readonly stdout: string[];
  readonly stderr: string[];
  invocation(): CliInvocation | null;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let selected: CliInvocation | null = null;

  const program = new Command()
    .name("vlint")
    .description("Detect UI layout violations in declared targets.")
    .version(`vlint ${version}`)
    .showSuggestionAfterError();

  program.configureHelp({ helpWidth: HELP_WIDTH });
  program.configureOutput({
    writeOut: (value) => stdout.push(value),
    writeErr: (value) => stderr.push(value),
    outputError: (value, write) => write(sanitizeCommanderError(value, rawArgs)),
    getOutHelpWidth: () => HELP_WIDTH,
    getErrHelpWidth: () => HELP_WIDTH,
    getOutHasColors: () => false,
    getErrHasColors: () => false,
  });
  program.exitOverride();

  program
    .command("check")
    .description("Run configured layout checks.")
    .option("--url <url>", "Check one absolute HTTP(S) URL instead of provider targets.")
    .addOption(
      new Option("--format <format>", "Select terminal or JSON output.")
        .choices(["terminal", "json"])
        .default("terminal"),
    )
    .action((options: { url?: string; format: OutputFormat }, command: Command) => {
      const url = options.url ?? null;
      if (url !== null) {
        const parsed = parseAdHocUrl(url);
        if (!parsed.ok) command.error(`error: option '--url <url>' ${parsed.failure.message}`);
      }
      selected = { kind: "check", url, format: options.format };
    });

  const browser = program.command("browser").description("Manage the pinned Chromium browser.");
  browser
    .command("install")
    .description("Install or repair the pinned Chromium browser.")
    .option("--force", "Repair or reinstall the browser payload.")
    .option("--with-deps", "Install Ubuntu system dependencies first.")
    .action((options: { force?: boolean; withDeps?: boolean }) => {
      selected = {
        kind: "browser-install",
        force: options.force === true,
        withDeps: options.withDeps === true,
      };
    });
  browser
    .command("status")
    .description("Show browser readiness without downloading or installing.")
    .addOption(
      new Option("--format <format>", "Select terminal or JSON output.")
        .choices(["terminal", "json"])
        .default("terminal"),
    )
    .action((options: { format: OutputFormat }) => {
      selected = { kind: "browser-status", format: options.format };
    });

  program
    .command("init")
    .description(`Create ${CONFIG_NAME}.`)
    .action(() => {
      selected = { kind: "init" };
    });

  program
    .command("setup")
    .description("Create config if needed and install the browser.")
    .action(() => {
      selected = { kind: "setup" };
    });

  return { program, stdout, stderr, invocation: () => selected };
}

function terminalResult(
  exitCode: 0 | 1,
  stdout: readonly string[],
  stderr: readonly string[],
): CliParseResult {
  return { kind: "terminal", exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

export function parseCli(args: readonly string[], version = "0.0.0"): CliParseResult {
  const built = buildCliProgram(version, args);
  const helpIndex = helpFlagIndex(args);
  if (args.length === 0 || helpIndex >= 0) {
    const scope = helpIndex < 0 ? built.program : resolveHelpScope(built.program, args, helpIndex);
    scope.outputHelp();
    return terminalResult(0, built.stdout, built.stderr);
  }

  const unsafe = args.find(unsafeArgument);
  if (unsafe !== undefined) {
    try {
      built.program.error(`error: unsafe argument '${diagnosticArgument(unsafe)}'`);
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      return terminalResult(1, built.stdout, built.stderr);
    }
  }

  try {
    built.program.parse([...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    return terminalResult(error.exitCode === 0 ? 0 : 1, built.stdout, built.stderr);
  }

  const invocation = built.invocation();
  if (invocation !== null) return { kind: "invocation", invocation };
  try {
    built.program.error("error: missing command");
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    return terminalResult(1, built.stdout, built.stderr);
  }
  throw new Error("unreachable CLI parse state");
}

export function renderCliHelpContract(version: string): string {
  const { program } = buildCliProgram(version, []);
  const sections: string[] = [];
  const visit = (command: Command, path: string): void => {
    sections.push(`$ ${path} --help\n${command.helpInformation()}`);
    for (const child of command.commands) visit(child, `${path} ${child.name()}`);
  };
  visit(program, program.name());
  return sections.join("\n");
}

export async function runCli(
  args: readonly string[],
  runtime: CliRuntime,
  io: CliIo,
  signal?: AbortSignal,
): Promise<0 | 1 | 2> {
  const parsed = parseCli(args, runtime.version);
  if (parsed.kind === "terminal") {
    if (parsed.stdout.length > 0) io.stdout(parsed.stdout);
    if (parsed.stderr.length > 0) io.stderr(parsed.stderr);
    return parsed.exitCode;
  }
  const invocation = parsed.invocation;
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
  if (invocation.kind === "browser-status") {
    const statusResult = await runtime.status(invocation.format, signal);
    if (!statusResult.ok) {
      io.stderr(`vlint: ${statusResult.failure.code}: ${escapeTerminal(statusResult.failure.message)}\n`);
      return 2;
    }
    io.stdout(statusResult.value.output);
    return statusResult.value.ready ? 0 : 2;
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
  const result = await runtime.check(invocation.url, signal);
  io.stdout(invocation.format === "json" ? renderJson(result) : renderTerminal(result));
  if (result.status === "incomplete") return 2;
  return result.status === "violations" ? 1 : 0;
}

declare const __VLINT_VERSION__: string;
const TOOL_VERSION =
  typeof __VLINT_VERSION__ === "string" ? __VLINT_VERSION__ : "0.4.0";

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
  status: (format, signal) =>
    Promise.resolve(
      runBrowserStatus({
        format,
        environment: process.env,
        ...(signal !== undefined ? { signal } : {}),
      }),
    ),
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
