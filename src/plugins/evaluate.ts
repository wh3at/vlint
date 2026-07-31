import type { Page } from "playwright";
import type { EffectiveAuditCase, EffectiveLocalRule } from "../contracts/config";
import type {
  Geometry,
  LocalViolation,
  RuleEvaluationOutcome,
} from "../contracts/evaluation";
import type { Failure, FailureCode } from "../contracts/failure";
import type { JsonValue } from "../contracts/plugins";
import { verifyUniqueLocator } from "../rules/locator";
import type { LoadedPluginContract } from "./types";

export const MAX_LOCAL_VIOLATIONS_PER_CASE = 100;
export const MAX_LOCAL_MESSAGE_BYTES = 64 * 1024;
export const MAX_LOCAL_DETAILS_BYTES = 16 * 1024;
export const MAX_NORMALIZED_DEPTH = 16;
export const MAX_NORMALIZED_ARRAY_ITEMS = 64;
export const MAX_NORMALIZED_OBJECT_KEYS = 64;
export const MAX_NORMALIZED_AGGREGATE_BYTES = 64 * 1024;
export const PLUGIN_EVALUATION_TIMEOUT_MS = 30_000;

export interface PluginBrowserContext {
  readonly settings: Record<string, JsonValue>;
  readonly target: {
    readonly name: string;
    readonly url: string;
  };
  readonly device: {
    readonly name: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly screen: { readonly width: number; readonly height: number };
    readonly deviceScaleFactor: number;
    readonly isMobile: boolean;
    readonly hasTouch: boolean;
    readonly userAgent: string | null;
    readonly locale: string;
    readonly timezoneId: string;
  };
}

interface InPageViolation {
  readonly message: string;
  readonly locator: string;
  readonly geometry: Geometry;
  readonly details: JsonValue;
}

interface InPageSuccess {
  readonly ok: true;
  readonly elementsInspected: number;
  readonly violations: readonly InPageViolation[];
}

interface InPageFailure {
  readonly ok: false;
  readonly code: FailureCode;
  readonly message: string;
}

type InPageOutcome = InPageSuccess | InPageFailure;

interface InPageEvaluateArgs {
  readonly evaluateJs: string;
  readonly context: PluginBrowserContext;
}

function buildContextForRule(rule: EffectiveLocalRule, auditCase: EffectiveAuditCase): PluginBrowserContext {
  return {
    settings: { ...rule.settings },
    target: { name: auditCase.name, url: auditCase.url },
    device: {
      name: auditCase.deviceName,
      viewport: auditCase.viewport,
      screen: auditCase.screen,
      deviceScaleFactor: auditCase.deviceScaleFactor,
      isMobile: auditCase.isMobile,
      hasTouch: auditCase.hasTouch,
      userAgent: auditCase.userAgent,
      locale: auditCase.locale,
      timezoneId: auditCase.timezoneId,
    },
  };
}

function evaluationFailure(
  code: FailureCode,
  message: string,
  ruleName: string,
  targetName: string | null,
): Failure {
  return { stage: "rule-evaluation", code, message, target: targetName, device: null, rule: ruleName };
}

function interruptedOutcome(
  rule: EffectiveLocalRule,
  auditCase: EffectiveAuditCase,
  targetName: string | null,
): RuleEvaluationOutcome<LocalViolation> {
  return {
    facts: { elementsInspected: 0, violations: [] },
    failure: {
      stage: "interrupt",
      code: "signal-interrupt",
      message: "operation interrupted by signal",
      target: targetName,
      device: auditCase.deviceName,
      rule: rule.name,
    },
  };
}

function roundFinite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/**
 * Closure-free in-page runner. Serializes plugin evaluator output to bounded plain
 * JSON before it crosses Playwright (KTD13).
 */
async function inPagePluginEvaluator(args: InPageEvaluateArgs): Promise<InPageOutcome> {
  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const MAX_DEPTH = 16;
  const MAX_ITEMS = 64;
  const MAX_KEYS = 64;
  const MAX_AGGREGATE = 64 * 1024;
  const MAX_MESSAGE = 64 * 1024;
  const MAX_DETAILS = 16 * 1024;
  const MAX_VIOLATIONS = 100;

  function normalizeJson(
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
    aggregate: { bytes: number },
  ): JsonValue | null {
    if (depth > MAX_DEPTH) return null;
    if (value === null) return null;
    if (typeof value === "string") {
      aggregate.bytes += new TextEncoder().encode(value).byteLength;
      if (aggregate.bytes > MAX_AGGREGATE) return null;
      return value;
    }
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return null;
    if (typeof Node !== "undefined" && value instanceof Node) return null;
    if (typeof Element !== "undefined" && value instanceof Element) return null;
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) return null;
      const items: JsonValue[] = [];
      for (const item of value) {
        const normalized = normalizeJson(item, depth + 1, seen, aggregate);
        if (normalized === null && item !== null) return null;
        items.push(normalized);
      }
      return items;
    }
    if (typeof value === "object") {
      if (seen.has(value)) return null;
      seen.add(value);
      const keys = Object.keys(value as object);
      if (keys.length > MAX_KEYS) return null;
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of keys) {
        if (DANGEROUS_KEYS.has(key)) return null;
        const normalized = normalizeJson((value as Record<string, unknown>)[key], depth + 1, seen, aggregate);
        if (normalized === null && (value as Record<string, unknown>)[key] !== null) return null;
        result[key] = normalized;
      }
      return result;
    }
    return null;
  }

  function normalizeViolation(raw: unknown): InPageViolation | null {
    if (raw === null || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.message !== "string" || typeof record.locator !== "string") return null;
    if (new TextEncoder().encode(record.message).byteLength > MAX_MESSAGE) return null;
    const geometry = record.geometry;
    if (geometry === null || typeof geometry !== "object") return null;
    const geo = geometry as Record<string, unknown>;
    if (
      !Number.isFinite(geo.x) ||
      !Number.isFinite(geo.y) ||
      !Number.isFinite(geo.width) ||
      !Number.isFinite(geo.height)
    ) {
      return null;
    }
    const aggregate = { bytes: 0 };
    const details = normalizeJson(record.details ?? null, 0, new WeakSet(), aggregate);
    if (details === null && record.details !== undefined && record.details !== null) return null;
    const detailsBytes = new TextEncoder().encode(JSON.stringify(details)).byteLength;
    if (detailsBytes > MAX_DETAILS || aggregate.bytes > MAX_AGGREGATE) return null;
    return {
      message: record.message,
      locator: record.locator,
      geometry: {
        x: geo.x as number,
        y: geo.y as number,
        width: geo.width as number,
        height: geo.height as number,
      },
      details: details ?? null,
    };
  }

  try {
    const AsyncFunctionCtor = Object.getPrototypeOf(async function asyncPlugin() {}).constructor as new (
      ...args: string[]
    ) => (context: PluginBrowserContext) => Promise<unknown>;
    const evaluate = new AsyncFunctionCtor("context", `return (${args.evaluateJs})(context);`);
    const resolved = await evaluate(args.context);
    if (resolved === null || typeof resolved !== "object") {
      return { ok: false, code: "plugin-evaluator-invalid", message: "plugin evaluator returned an invalid shape" };
    }
    const record = resolved as Record<string, unknown>;
    const elementsInspected = record.elementsInspected;
    if (!Number.isInteger(elementsInspected) || (elementsInspected as number) < 0) {
      return {
        ok: false,
        code: "local-fact-invalid",
        message: "plugin evaluator returned an invalid elementsInspected count",
      };
    }
    if (!Array.isArray(record.violations)) {
      return { ok: false, code: "plugin-evaluator-invalid", message: "plugin evaluator violations must be an array" };
    }
    if (record.violations.length > MAX_VIOLATIONS) {
      return {
        ok: false,
        code: "plugin-diagnostic-too-large",
        message: "plugin evaluator returned too many violations",
      };
    }
    const violations: InPageViolation[] = [];
    for (const item of record.violations) {
      const normalized = normalizeViolation(item);
      if (normalized === null) {
        return {
          ok: false,
          code: "local-violation-invalid",
          message: "plugin evaluator returned an invalid violation",
        };
      }
      violations.push(normalized);
    }
    return { ok: true, elementsInspected: elementsInspected as number, violations };
  } catch (error) {
    return { ok: false, code: "plugin-evaluator-invalid", message: "plugin evaluator failed" };
  }
}

async function verifyViolations(
  page: Page,
  violations: readonly InPageViolation[],
  ruleName: string,
  targetName: string | null,
  elementsInspected: number,
  accepted: readonly LocalViolation[],
): Promise<RuleEvaluationOutcome<LocalViolation>> {
  const resolved: LocalViolation[] = [...accepted];
  for (const violation of violations) {
    const unique = await verifyUniqueLocator(page, violation.locator);
    if (!unique) {
      return {
        facts: { elementsInspected, violations: resolved },
        failure: evaluationFailure(
          "geometry-evaluation-failed",
          "local rule violation locator no longer resolves uniquely",
          ruleName,
          targetName,
        ),
      };
    }
    resolved.push({
      type: "local",
      message: violation.message,
      locator: violation.locator,
      geometry: {
        x: roundFinite(violation.geometry.x),
        y: roundFinite(violation.geometry.y),
        width: roundFinite(violation.geometry.width),
        height: roundFinite(violation.geometry.height),
      },
      details: violation.details,
    });
  }
  return { facts: { elementsInspected, violations: resolved }, failure: null };
}

function mapInPageFailure(
  outcome: InPageFailure,
  rule: EffectiveLocalRule,
  targetName: string | null,
): RuleEvaluationOutcome<LocalViolation> {
  return {
    facts: { elementsInspected: 0, violations: [] },
    failure: evaluationFailure(outcome.code, outcome.message, rule.name, targetName),
  };
}

export async function evaluateLocalRule(
  page: Page,
  rule: EffectiveLocalRule,
  contract: LoadedPluginContract,
  auditCase: EffectiveAuditCase,
  targetName: string | null = auditCase.name,
  signal?: AbortSignal,
): Promise<RuleEvaluationOutcome<LocalViolation>> {
  if (signal?.aborted === true) return interruptedOutcome(rule, auditCase, targetName);

  const evaluateJs = contract.evaluateJs;
  const context = buildContextForRule(rule, auditCase);
  const evaluationPromise = (async () => {
    const result = await (page.evaluate as (fn: unknown, arg: unknown) => Promise<unknown>)(
      inPagePluginEvaluator,
      { evaluateJs, context },
    );
    return result as InPageOutcome;
  })();

  let abortListener: (() => void) | null = null;
  const interruption =
    signal === undefined
      ? null
      : new Promise<RuleEvaluationOutcome<LocalViolation>>((resolveInterruption) => {
          abortListener = () => resolveInterruption(interruptedOutcome(rule, auditCase, targetName));
          signal.addEventListener("abort", abortListener, { once: true });
        });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<RuleEvaluationOutcome<LocalViolation>>((resolveTimeout) => {
    timeoutId = setTimeout(
      () =>
        resolveTimeout({
          facts: { elementsInspected: 0, violations: [] },
          failure: evaluationFailure(
            "plugin-evaluation-timeout",
            `plugin evaluation exceeded ${PLUGIN_EVALUATION_TIMEOUT_MS} ms`,
            rule.name,
            targetName,
          ),
        }),
      PLUGIN_EVALUATION_TIMEOUT_MS,
    );
  });

  try {
    const raced = await Promise.race([
      evaluationPromise,
      timeoutOutcome,
      ...(interruption === null ? [] : [interruption]),
    ]);
    if ("failure" in raced && raced.failure !== null && "facts" in raced) {
      return raced as RuleEvaluationOutcome<LocalViolation>;
    }
    const outcome = raced as InPageOutcome;
    if (!outcome.ok) return mapInPageFailure(outcome, rule, targetName);
    return verifyViolations(
      page,
      outcome.violations,
      rule.name,
      targetName,
      outcome.elementsInspected,
      [],
    );
  } catch {
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: evaluationFailure(
        "rule-script-failed",
        "local rule evaluation could not read the page",
        rule.name,
        targetName,
      ),
    };
  } finally {
    if (abortListener !== null && signal !== undefined) signal.removeEventListener("abort", abortListener);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
