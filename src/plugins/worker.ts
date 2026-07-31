import ts from "typescript";
import type { PluginContractDescriptor } from "../contracts/plugins";
import {
  boundaryFailure,
  boundarySuccess,
  type BoundaryResult,
  type FailureCode,
} from "../contracts/failure";
import { parsePluginContractExport } from "./schema";
import {
  MAX_PLUGIN_SOURCE_BYTES,
  PLUGIN_LOADER_WORKER_TOKEN,
  type PluginWorkerFailure,
  type PluginWorkerResponse,
  type PluginWorkerSuccess,
} from "./types";

const WORKER_ENV = "VLINT_PLUGIN_WORKER_TOKEN";

export function pluginLoaderWorkerArgs(
  argv: readonly string[],
): { readonly token: string; readonly snapshotPath: string } | null {
  const index = argv.indexOf(PLUGIN_LOADER_WORKER_TOKEN);
  if (index < 0) return null;
  const token = argv[index + 1];
  const snapshotPath = argv[index + 2];
  if (typeof token !== "string" || typeof snapshotPath !== "string") return null;
  return { token, snapshotPath };
}

export function isPluginLoaderWorkerInvocation(argv: readonly string[]): boolean {
  return pluginLoaderWorkerArgs(argv) !== null;
}

function workerFailure(code: FailureCode, message: string): PluginWorkerFailure {
  return { ok: false, code, message };
}

function emitWorkerResponse(response: PluginWorkerResponse): never {
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(response.ok ? 0 : 2);
}

function extractDefaultExportObject(source: string): ts.ObjectLiteralExpression | null {
  const file = ts.createSourceFile("plugin.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const expression = statement.expression;
    if (ts.isObjectLiteralExpression(expression)) return expression;
  }
  return null;
}

function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    const propertyName =
      ts.isIdentifier(key) ? key.text : ts.isStringLiteral(key) ? key.text : undefined;
    if (propertyName === name) return property.initializer;
  }
  return undefined;
}

function expressionSource(source: string, expression: ts.Expression): string {
  return source.slice(expression.getStart(), expression.getEnd());
}

function isFunctionExpression(expression: ts.Expression): boolean {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

export function extractCallbackSources(source: string): BoundaryResult<{
  readonly evaluateSource: string;
  readonly finalizeSource?: string;
}> {
  const object = extractDefaultExportObject(source);
  if (object === null) {
    return boundaryFailure({
      stage: "config",
      code: "plugin-contract-invalid",
      message: "plugin must default-export an object literal",
      target: null,
      device: null,
      rule: null,
    });
  }
  const evaluate = propertyInitializer(object, "evaluate");
  if (evaluate === undefined || !isFunctionExpression(evaluate)) {
    return boundaryFailure({
      stage: "config",
      code: "plugin-contract-invalid",
      message: "plugin evaluate must be a function expression",
      target: null,
      device: null,
      rule: null,
    });
  }
  const finalize = propertyInitializer(object, "finalize");
  if (finalize !== undefined && !isFunctionExpression(finalize)) {
    return boundaryFailure({
      stage: "config",
      code: "plugin-contract-invalid",
      message: "plugin finalize must be a function expression when present",
      target: null,
      device: null,
      rule: null,
    });
  }
  return boundarySuccess({
    evaluateSource: expressionSource(source, evaluate),
    ...(finalize === undefined ? {} : { finalizeSource: expressionSource(source, finalize) }),
  });
}

async function loadSnapshotModule(snapshotPath: string): Promise<BoundaryResult<unknown>> {
  try {
    const imported = await import(snapshotPath);
    return boundarySuccess(imported.default);
  } catch (error) {
    const message = error instanceof Error ? error.message : "plugin module failed to load";
    return boundaryFailure({
      stage: "config",
      code: "plugin-load-failed",
      message,
      target: null,
      device: null,
      rule: null,
    });
  }
}

export async function runPluginLoaderWorkerMain(argv: readonly string[]): Promise<void> {
  const args = pluginLoaderWorkerArgs(argv);
  if (args === null || args.token !== process.env[WORKER_ENV]) {
    emitWorkerResponse(workerFailure("plugin-load-failed", "plugin loader worker token is invalid"));
  }
  const { snapshotPath } = args;
  let source: string;
  try {
    const file = Bun.file(snapshotPath);
    const size = file.size;
    if (size > MAX_PLUGIN_SOURCE_BYTES) {
      emitWorkerResponse(workerFailure("plugin-source-too-large", "plugin source exceeds 8 MiB"));
    }
    source = await file.text();
  } catch {
    emitWorkerResponse(workerFailure("plugin-source-read-failed", "plugin source could not be read"));
  }
  const callbacks = extractCallbackSources(source);
  if (!callbacks.ok) {
    emitWorkerResponse(workerFailure(callbacks.failure.code, callbacks.failure.message));
  }
  const exported = await loadSnapshotModule(snapshotPath);
  if (!exported.ok) {
    emitWorkerResponse(workerFailure(exported.failure.code, exported.failure.message));
  }
  const descriptor = parsePluginContractExport(
    exported.value,
    callbacks.value.evaluateSource,
    callbacks.value.finalizeSource,
  );
  if (!descriptor.ok) {
    emitWorkerResponse(workerFailure(descriptor.failure.code, descriptor.failure.message));
  }
  const success: PluginWorkerSuccess = { ok: true, descriptor: descriptor.value };
  emitWorkerResponse(success);
}

export function parsePluginWorkerResponse(stdout: string): BoundaryResult<PluginContractDescriptor> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return boundaryFailure({
      stage: "config",
      code: "plugin-descriptor-invalid",
      message: "plugin loader produced no output",
      target: null,
      device: null,
      rule: null,
    });
  }
  let parsed: PluginWorkerResponse;
  try {
    parsed = JSON.parse(trimmed) as PluginWorkerResponse;
  } catch {
    return boundaryFailure({
      stage: "config",
      code: "plugin-descriptor-invalid",
      message: "plugin loader output is not valid JSON",
      target: null,
      device: null,
      rule: null,
    });
  }
  if (!parsed.ok) {
    return boundaryFailure({
      stage: "config",
      code: parsed.code,
      message: parsed.message,
      target: null,
      device: null,
      rule: null,
    });
  }
  return boundarySuccess(parsed.descriptor);
}
