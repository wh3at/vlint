import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { EffectiveLocalRule, EffectiveRule, LoadedConfig, ResolvedCheckPlan } from "../contracts/config";
import type { PluginContractDescriptor } from "../contracts/plugins";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type Failure,
} from "../contracts/failure";
import { parsePluginWorkerResponse } from "./worker";
import { validatePluginSettings } from "./schema";
import {
  MAX_DESCRIPTOR_JSON_BYTES,
  MAX_PLUGIN_SOURCE_BYTES,
  PLUGIN_LOADER_CLEANUP_GRACE_MS,
  PLUGIN_LOADER_STDERR_LIMIT,
  PLUGIN_LOADER_STDOUT_LIMIT,
  PLUGIN_LOADER_TIMEOUT_MS,
  PLUGIN_LOADER_WORKER_TOKEN,
  type LoadedPluginContract,
  type PluginFinalizeFn,
  type PluginLoadOptions,
  type PluginRuntimeRegistry,
} from "./types";

const WORKER_ENV = "VLINT_PLUGIN_WORKER_TOKEN";
const CLI_ENTRY = fileURLToPath(new URL("../cli.ts", import.meta.url));

interface SnapshotRead {
  readonly canonicalPath: string;
  readonly bytes: Uint8Array;
}

function pluginFailure(
  code: Failure["code"],
  message: string,
  rule: string | null = null,
): Failure {
  return { stage: "config", code, message, target: null, device: null, rule };
}

function hasLocalRules(rules: readonly EffectiveRule[]): boolean {
  return rules.some((rule) => rule.type === "local");
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  retain: boolean,
): Promise<{ readonly bytes: Uint8Array; readonly overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { bytes: new Uint8Array(0), overflow: true };
      }
      if (retain) chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!retain) return { bytes: new Uint8Array(0), overflow: false };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow: false };
}

async function terminateProcessGroup(child: Bun.Subprocess): Promise<boolean> {
  const signalGroup = (signal: number): boolean => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
      return false;
    }
  };
  let ok = signalGroup(15);
  try {
    child.kill(15);
  } catch {
    if (child.exitCode === null) ok = false;
  }
  await Promise.race([child.exited, Bun.sleep(PLUGIN_LOADER_CLEANUP_GRACE_MS)]);
  ok = signalGroup(9) && ok;
  try {
    child.kill(9);
  } catch {
    if (child.exitCode === null) ok = false;
  }
  const reaped = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(PLUGIN_LOADER_CLEANUP_GRACE_MS).then(() => false),
  ]);
  return ok && reaped;
}

function collectRuntimeDependencies(source: string, file: ts.SourceFile): readonly string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const scan = transpiler.scan(source);
  const dependencies = new Set<string>();
  for (const item of scan.imports) dependencies.add(item.path);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) dependencies.add(argument.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.add(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...dependencies];
}

function isTypeOnlyImport(file: ts.SourceFile, specifier: string): boolean {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    if (statement.importClause?.isTypeOnly === true) return true;
    const elements = statement.importClause?.namedBindings;
    if (elements !== undefined && ts.isNamedImports(elements)) {
      return elements.elements.every((element) => element.isTypeOnly);
    }
  }
  return false;
}

async function canonicalSnapshotPath(
  configDirectory: string,
  relativePath: string,
): Promise<BoundaryResult<string>> {
  if (relativePath.startsWith("/")) {
    return boundaryFailure(pluginFailure("plugin-path-invalid", "plugin path must be relative"));
  }
  if (relativePath.includes("\0")) {
    return boundaryFailure(pluginFailure("plugin-path-invalid", "plugin path is invalid"));
  }
  const segments = relativePath.split(/[/\\]/).filter((segment) => segment.length > 0 && segment !== ".");
  let current = resolve(configDirectory);
  for (const segment of segments) {
    if (segment === "..") {
      return boundaryFailure(pluginFailure("plugin-path-invalid", "plugin path must stay inside the configuration directory"));
    }
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        return boundaryFailure(pluginFailure("plugin-path-invalid", "plugin path must not use symbolic links"));
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      return boundaryFailure(
        pluginFailure(
          code === "ENOENT" ? "plugin-file-not-found" : "plugin-source-read-failed",
          code === "ENOENT" ? "plugin source file was not found" : "plugin source could not be read",
        ),
      );
    }
  }
  const root = resolve(configDirectory);
  if (!(current === root || current.startsWith(`${root}/`))) {
    return boundaryFailure(pluginFailure("plugin-path-invalid", "plugin path must stay inside the configuration directory"));
  }
  return boundarySuccess(current);
}

async function readVerifiedSnapshot(
  configDirectory: string,
  relativePath: string,
): Promise<BoundaryResult<SnapshotRead>> {
  const canonical = await canonicalSnapshotPath(configDirectory, relativePath);
  if (!canonical.ok) return canonical;
  let handle;
  try {
    handle = await open(canonical.value, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return boundaryFailure(
      pluginFailure(
        code === "ENOENT" ? "plugin-file-not-found" : "plugin-source-read-failed",
        code === "ENOENT" ? "plugin source file was not found" : "plugin source could not be read",
      ),
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return boundaryFailure(pluginFailure("plugin-source-read-failed", "plugin source is not a regular file"));
    }
    if (stat.size > MAX_PLUGIN_SOURCE_BYTES) {
      return boundaryFailure(pluginFailure("plugin-source-too-large", "plugin source exceeds 8 MiB"));
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_PLUGIN_SOURCE_BYTES) {
      return boundaryFailure(pluginFailure("plugin-source-too-large", "plugin source exceeds 8 MiB"));
    }
    return boundarySuccess({ canonicalPath: canonical.value, bytes });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function scanForbiddenDependencies(source: string): BoundaryResult<void> {
  let file: ts.SourceFile;
  let dependencies: readonly string[];
  try {
    file = ts.createSourceFile("plugin.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    dependencies = collectRuntimeDependencies(source, file);
  } catch {
    return boundaryFailure(pluginFailure("plugin-transpile-failed", "plugin source could not be scanned"));
  }
  for (const dependency of dependencies) {
    if (dependency.startsWith("node:")) continue;
    if (isTypeOnlyImport(file, dependency)) continue;
    return boundaryFailure(
      pluginFailure("plugin-dependency-forbidden", `plugin source must not import ${dependency}`),
    );
  }
  return boundarySuccess(undefined);
}

const AsyncFunctionCtor = Object.getPrototypeOf(async function asyncFunctionCtor() {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const CALLBACK_ASSIGNMENT_MARKERS = [
  "const __vlint_callback = ",
  "let __vlint_callback = ",
  "var __vlint_callback = ",
] as const;

function extractTranspiledAssignmentRhs(transformed: string, variableName: string): string {
  const markers = [
    `const ${variableName} = `,
    `let ${variableName} = `,
    `var ${variableName} = `,
  ];
  let start = -1;
  for (const marker of markers) {
    const index = transformed.indexOf(marker);
    if (index >= 0) {
      start = index + marker.length;
      break;
    }
  }
  if (start < 0) {
    throw new Error("plugin callback assignment was not found in transpiled output");
  }

  let index = start;
  while (index < transformed.length && /\s/.test(transformed[index] ?? "")) index += 1;

  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  const atTopLevel = (): boolean =>
    depthParen === 0 && depthBrace === 0 && depthBracket === 0 && !inSingle && !inDouble && !inTemplate;

  for (; index < transformed.length; index += 1) {
    const char = transformed[index]!;
    const next = transformed[index + 1];

    if (inSingle) {
      if (!escaped && char === "'") inSingle = false;
      escaped = !escaped && char === "\\";
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '"') inDouble = false;
      escaped = !escaped && char === "\\";
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === "`") inTemplate = false;
      escaped = !escaped && char === "\\";
      continue;
    }

    if (char === "'" ) {
      inSingle = true;
      escaped = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      escaped = false;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < transformed.length && transformed[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < transformed.length - 1 && !(transformed[index] === "*" && transformed[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "{") depthBrace += 1;
    else if (char === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (char === "[") depthBracket += 1;
    else if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (char === ";" && atTopLevel()) {
      return transformed.slice(start, index).trim();
    }
  }

  throw new Error("plugin callback expression was not terminated in transpiled output");
}

export function transpilePluginCallbackSource(source: string): string {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const wrapped = `const __vlint_callback = ${source};`;
  let transformed: string;
  try {
    transformed = transpiler.transformSync(wrapped);
  } catch {
    throw new Error("plugin callback could not be transpiled");
  }
  for (const marker of CALLBACK_ASSIGNMENT_MARKERS) {
    if (transformed.includes(marker)) {
      return extractTranspiledAssignmentRhs(transformed, "__vlint_callback");
    }
  }
  throw new Error("plugin callback could not be transpiled");
}

function reconstructFinalize(source: string): PluginFinalizeFn {
  const js = transpilePluginCallbackSource(source);
  const fn = new AsyncFunctionCtor("observations", `return (${js})(observations);`);
  return fn as PluginFinalizeFn;
}

function buildRegistry(contracts: ReadonlyMap<string, LoadedPluginContract>): PluginRuntimeRegistry {
  return {
    contracts,
    get(ruleName: string) {
      return contracts.get(ruleName);
    },
  };
}

function usesEmbeddedCliEntry(executablePath: string): boolean {
  const base = executablePath.split("/").pop() ?? executablePath;
  return base === "bun" || base === "bun.exe";
}

function workerSpawnCommand(
  executablePath: string,
  token: string,
  snapshotPath: string,
): readonly string[] {
  if (usesEmbeddedCliEntry(executablePath)) {
    return [executablePath, CLI_ENTRY, PLUGIN_LOADER_WORKER_TOKEN, token, snapshotPath];
  }
  return [executablePath, PLUGIN_LOADER_WORKER_TOKEN, token, snapshotPath];
}

async function invokePluginWorker(
  executablePath: string,
  snapshotPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundaryResult<PluginContractDescriptor>> {
  const token = randomBytes(16).toString("hex");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...workerSpawnCommand(executablePath, token, snapshotPath)], {
      cwd: dirname(snapshotPath),
      env: { ...process.env, [WORKER_ENV]: token },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch {
    return boundaryFailure(pluginFailure("plugin-load-failed", "plugin loader could not be started"));
  }

  const stdoutPromise = readBounded(child.stdout, PLUGIN_LOADER_STDOUT_LIMIT, true);
  const stderrPromise = readBounded(child.stderr, PLUGIN_LOADER_STDERR_LIMIT, false);
  const normalPromise = Promise.all([child.exited, stdoutPromise, stderrPromise]).then(
    ([exitCode, stdout, stderr]) => ({ type: "normal" as const, exitCode, stdout, stderr }),
  );
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ type: "timeout" as const }));
  const abortPromise = new Promise<{ type: "abort" }>((resolveAbort) => {
    if (signal?.aborted === true) resolveAbort({ type: "abort" });
    else signal?.addEventListener("abort", () => resolveAbort({ type: "abort" }), { once: true });
  });
  const outcome = await Promise.race([normalPromise, timeoutPromise, abortPromise]);
  if (outcome.type !== "normal") {
    const cleaned = await terminateProcessGroup(child);
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    if (!cleaned) {
      return boundaryFailure(pluginFailure("plugin-load-failed", "plugin loader cleanup failed"));
    }
    if (outcome.type === "abort") {
      return boundaryFailure({
        stage: "interrupt",
        code: "signal-interrupt",
        message: "plugin loader interrupted",
        target: null,
        device: null,
        rule: null,
      });
    }
    return boundaryFailure(pluginFailure("plugin-load-timeout", `plugin loader exceeded ${timeoutMs} ms`));
  }
  if (!(await terminateProcessGroup(child))) {
    return boundaryFailure(pluginFailure("plugin-load-failed", "plugin loader cleanup failed"));
  }
  if (outcome.stdout.overflow || outcome.stderr.overflow) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin loader output exceeded its limit"));
  }
  if (outcome.exitCode !== 0) {
    if (outcome.stdout.bytes.byteLength > 0) {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(outcome.stdout.bytes);
      const parsed = parsePluginWorkerResponse(decoded);
      if (!parsed.ok) return parsed;
    }
    return boundaryFailure(pluginFailure("plugin-load-failed", `plugin loader exited with ${outcome.exitCode}`));
  }
  if (outcome.stdout.bytes.byteLength > MAX_DESCRIPTOR_JSON_BYTES) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin descriptor is too large"));
  }
  const stdout = new TextDecoder("utf-8", { fatal: true }).decode(outcome.stdout.bytes);
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    return boundaryFailure(pluginFailure("plugin-descriptor-invalid", "plugin loader must write exactly one stdout line"));
  }
  return parsePluginWorkerResponse(lines[0] ?? "");
}

export async function loadPluginContract(
  options: PluginLoadOptions,
): Promise<BoundaryResult<LoadedPluginContract>> {
  const snapshot = await readVerifiedSnapshot(options.configDirectory, options.relativePath);
  if (!snapshot.ok) {
    return boundaryFailure({ ...snapshot.failure, rule: options.ruleName });
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.value.bytes);
  const scanned = scanForbiddenDependencies(source);
  if (!scanned.ok) {
    return boundaryFailure({ ...scanned.failure, rule: options.ruleName });
  }
  const tempDirectory = await mkdtemp(join(tmpdir(), "vlint-plugin-"));
  const snapshotPath = join(tempDirectory, "rule.ts");
  try {
    await writeFile(snapshotPath, snapshot.value.bytes);
    const executablePath = options.executablePath ?? process.execPath;
    const descriptor = await invokePluginWorker(
      executablePath,
      snapshotPath,
      options.timeoutMs ?? PLUGIN_LOADER_TIMEOUT_MS,
      options.signal,
    );
    if (!descriptor.ok) {
      return boundaryFailure({ ...descriptor.failure, rule: options.ruleName });
    }
    let evaluateJs: string;
    let finalize: PluginFinalizeFn | null = null;
    try {
      evaluateJs = transpilePluginCallbackSource(descriptor.value.evaluateSource);
      if (descriptor.value.finalizeSource !== undefined) {
        finalize = reconstructFinalize(descriptor.value.finalizeSource);
      }
    } catch {
      return boundaryFailure(
        pluginFailure("plugin-descriptor-invalid", "plugin callbacks could not be reconstructed", options.ruleName),
      );
    }
    return boundarySuccess({
      descriptor: descriptor.value,
      evaluateJs,
      finalize,
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function loadLocalPluginRegistry(
  config: LoadedConfig,
  options: {
    readonly executablePath?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<BoundaryResult<PluginRuntimeRegistry | null>> {
  const localRules = config.rules.filter((rule): rule is EffectiveLocalRule => rule.type === "local");
  if (localRules.length === 0) return boundarySuccess(null);
  const byPath = new Map<string, EffectiveLocalRule[]>();
  for (const rule of localRules) {
    const existing = byPath.get(rule.path) ?? [];
    existing.push(rule);
    byPath.set(rule.path, existing);
  }
  const contracts = new Map<string, LoadedPluginContract>();
  for (const [relativePath, rulesForPath] of byPath) {
    const loaded = await loadPluginContract({
      configDirectory: config.directory,
      relativePath,
      ruleName: rulesForPath[0]?.name ?? relativePath,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!loaded.ok) return boundaryFailure(loaded.failure);
    for (const rule of rulesForPath) {
      const settings = validatePluginSettings(
        loaded.value.descriptor.settingsSchema,
        rule.settings,
        `rules.${rule.name}.settings`,
        rule.name,
      );
      if (!settings.ok) return boundaryFailure(settings.failure);
      contracts.set(rule.name, loaded.value);
    }
  }
  return boundarySuccess(buildRegistry(contracts));
}

export function validateEffectiveLocalSettings(
  registry: PluginRuntimeRegistry | null,
  plan: ResolvedCheckPlan,
): BoundaryResult<void> {
  if (registry === null) return boundarySuccess(undefined);
  for (const auditCase of plan.cases) {
    for (const rule of auditCase.rules) {
      if (rule.type !== "local") continue;
      const contract = registry.get(rule.name);
      if (contract === undefined) {
        return boundaryFailure(pluginFailure("plugin-load-failed", "local rule plugin is not loaded", rule.name));
      }
      const validated = validatePluginSettings(
        contract.descriptor.settingsSchema,
        rule.settings,
        `targets.${auditCase.name}.ruleOverrides.${rule.name}.settings`,
        rule.name,
      );
      if (!validated.ok) return boundaryFailure(validated.failure);
    }
  }
  return boundarySuccess(undefined);
}

export function localPluginsConfigured(rules: readonly EffectiveRule[]): boolean {
  return hasLocalRules(rules);
}

export async function loadLocalPluginsForConfig(
  config: LoadedConfig,
  plan: ResolvedCheckPlan,
  options: {
    readonly executablePath?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<BoundaryResult<PluginRuntimeRegistry | null>> {
  if (!localPluginsConfigured(config.rules)) return boundarySuccess(null);
  const registry = await loadLocalPluginRegistry(config, options);
  if (!registry.ok) return registry;
  const effective = validateEffectiveLocalSettings(registry.value, plan);
  if (!effective.ok) return boundaryFailure(effective.failure);
  return registry;
}

export { isPluginLoaderWorkerInvocation } from "./worker";
