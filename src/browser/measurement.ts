import type { Page } from "playwright";
import type { EffectiveAuditCase, ReadyState } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";

interface GuardState {
  readonly url: string;
  readonly readyCondition: { readonly selector: string; readonly state: ReadyState } | null;
}

interface ReadyNode {
  readonly nodeType: number;
  readonly nextSibling: ReadyNode | null;
}

interface ReadyElement extends ReadyNode {
  readonly isConnected: boolean;
  readonly firstChild: ReadyNode | null;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number };
  contains(node: unknown): boolean;
  getRootNode(): { host?: ReadyElement };
}

interface MutationEvidence {
  readonly removedNodes: Iterable<unknown>;
  readonly target: unknown;
  readonly type: string;
}

interface GuardedValue {
  readonly value: unknown;
  readonly invalid: "url-mismatch" | "ready-lost" | "navigation-during-measurement" | null;
  readonly url: string;
}

async function inspectInPage(args: { code: string; isFunction: boolean; argument: unknown; guard: GuardState; execute: boolean; matches?: readonly ReadyElement[] }): Promise<GuardedValue> {
  const { code, isFunction, argument, guard, execute } = args;
  const global = globalThis as unknown as {
    location: { href: string };
    document: { createRange(): { selectNode(node: ReadyNode): void; getBoundingClientRect(): { width: number; height: number } } };
    getComputedStyle(element: unknown): { visibility: string; display: string };
    MutationObserver: new (callback: (records: readonly MutationEvidence[]) => void) => { observe(root: unknown, options: unknown): void; disconnect(): void };
    history: { pushState: (...args: unknown[]) => unknown; replaceState: (...args: unknown[]) => unknown };
    addEventListener(type: string, callback: () => void): void;
    removeEventListener(type: string, callback: () => void): void;
  };
  const isVisible = (element: ReadyElement): boolean => {
    const style = global.getComputedStyle(element);
    if (style.display === "contents") {
      for (let child = element.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1 && isVisible(child as ReadyElement)) return true;
        if (child.nodeType === 3) {
          const range = global.document.createRange();
          range.selectNode(child);
          const box = range.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) return true;
        }
      }
      return false;
    }
    if (!element.checkVisibility() || style.visibility !== "visible") return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  let invalid: GuardedValue["invalid"] = null;
  let invalidUrl = global.location.href;
  const current = (): void => {
    if (invalid !== null) return;
    if (new URL(global.location.href).href !== guard.url) {
      invalid = "url-mismatch";
      invalidUrl = global.location.href;
      return;
    }
    if (guard.readyCondition === null) return;
    const elements = (args.matches ?? []).filter((element) => element.isConnected);
    const visible = elements.some(isVisible);
    const ready = guard.readyCondition.state === "attached" ? elements.length > 0 : guard.readyCondition.state === "visible" ? visible : !visible;
    if (!ready) {
      invalid = "ready-lost";
      invalidUrl = global.location.href;
    }
  };
  current();
  if (invalid !== null || !execute) return { value: null, invalid, url: invalid === null ? global.location.href : invalidUrl };
  const observer = new global.MutationObserver((records) => {
    const matches = args.matches ?? [];
    const changedReady = guard.readyCondition !== null && records.some((record) => {
      if (guard.readyCondition?.state === "hidden") return true;
      if (matches.some((match) => {
        const host = match.getRootNode().host;
        return record.target === match || match.contains(record.target) || (record.target as ReadyElement).contains?.(match) ||
          (host !== undefined && (record.target === host || (record.target as ReadyElement).contains?.(host)));
      })) return true;
      return [...record.removedNodes].some((node) => matches.some((match) => {
        const root = match.getRootNode();
        return node === match || (node as ReadyElement).contains?.(match) || (root.host !== undefined && (node === root.host || (node as ReadyElement).contains?.(root.host)));
      }));
    });
    if (invalid === null && changedReady) {
      invalid = "ready-lost";
      invalidUrl = global.location.href;
    }
    current();
  });
  observer.observe(global.document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const match of args.matches ?? []) {
    const root = match.getRootNode();
    if (root !== global.document) observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const pushState = global.history.pushState;
  const replaceState = global.history.replaceState;
  global.history.pushState = function (...values: unknown[]) { const result = pushState.apply(this, values); current(); return result; };
  global.history.replaceState = function (...values: unknown[]) { const result = replaceState.apply(this, values); current(); return result; };
  global.addEventListener("popstate", current);
  global.addEventListener("hashchange", current);
  try {
    const expression = (0, eval)(`(${code})`) as (arg: unknown) => unknown;
    const value = await (isFunction ? expression(argument) : expression);
    current();
    return { value, invalid, url: invalid === null ? global.location.href : invalidUrl };
  } finally {
    observer.disconnect();
    global.history.pushState = pushState;
    global.history.replaceState = replaceState;
    global.removeEventListener("popstate", current);
    global.removeEventListener("hashchange", current);
  }
}

async function evaluateObserved(
  page: Page,
  guard: GuardState,
  code: string,
  isFunction: boolean,
  argument: unknown,
  execute: boolean,
): Promise<GuardedValue> {
  const args = { code, isFunction, argument, guard, execute };
  if (guard.readyCondition === null) return page.evaluate(inspectInPage, args);
  return page.locator(guard.readyCondition.selector).evaluateAll((matches, input) => {
    const inspect = (0, eval)(`(${input.script})`) as (args: typeof input.args & { matches: typeof matches }) => Promise<GuardedValue>;
    return inspect({ ...input.args, matches });
  }, { args, script: inspectInPage.toString() });
}

export function sameUrl(left: string, right: string): boolean {
  return new URL(left).href === new URL(right).href;
}

export function allowedArrival(auditCase: Pick<EffectiveAuditCase, "url" | "allowedUrls">, url: string): boolean {
  return [auditCase.url, ...(auditCase.allowedUrls ?? [])].some((allowed) => sameUrl(allowed, url));
}

export async function measureRule(
  page: Page,
  auditCase: EffectiveAuditCase,
  fixedUrl: string,
  evaluate: (page: Page) => Promise<RuleEvaluationOutcome>,
): Promise<RuleEvaluationOutcome> {
  const guard: GuardState = {
    url: new URL(fixedUrl).href,
    readyCondition: auditCase.readyCondition,
  };
  let detected: GuardedValue | null = null;
  const check = async (): Promise<void> => {
    if (detected !== null) return;
    try {
      const result = await evaluateObserved(page, guard, "null", false, null, false);
      if (result.invalid !== null && detected === null) detected = result;
    } catch {
      if (detected === null) detected = { value: null, invalid: !sameUrl(page.url(), fixedUrl) ? "url-mismatch" : guard.readyCondition === null ? "navigation-during-measurement" : "ready-lost", url: page.url() };
    }
  };
  const onNavigation = (frame: import("playwright").Frame): void => {
    if (detected === null && frame === page.mainFrame()) detected = { value: null, invalid: sameUrl(page.url(), fixedUrl) ? "navigation-during-measurement" : "url-mismatch", url: page.url() };
  };
  page.on("framenavigated", onNavigation);
  try {
    await check();
    const guarded = new Proxy(page, {
      get(source, property) {
        if (property !== "evaluate") return Reflect.get(source, property, source);
        return async (fn: unknown, argument?: unknown): Promise<unknown> => {
          const result = await evaluateObserved(source, guard, typeof fn === "string" ? fn : (fn as Function).toString(), typeof fn !== "string", argument, true);
          if (result.invalid !== null && detected === null) detected = result;
          return result.value;
        };
      },
    });
    let outcome: RuleEvaluationOutcome = { facts: { elementsInspected: 0, violations: [] }, failure: null };
    let evaluationError: unknown = null;
    try {
      if (detected === null) outcome = await evaluate(guarded);
    } catch (error) {
      evaluationError = error;
    }
    await check();
    const observed = detected as GuardedValue | null;
    if (observed === null) {
      if (evaluationError !== null) throw evaluationError;
      return outcome;
    }
    const failure: Failure = {
      stage: observed.invalid === "ready-lost" ? "ready-condition" : "navigation",
      code: observed.invalid === "ready-lost" ? "ready-lost" : observed.invalid === "url-mismatch" ? "url-mismatch" : "navigation-during-measurement",
      message: observed.invalid === "ready-lost" ? "ready condition lost during measurement" : "page navigated during measurement",
      target: auditCase.name,
      device: auditCase.deviceName,
      rule: null,
      actualUrl: observed.url,
    };
    return { facts: { elementsInspected: 0, violations: [] }, failure };
  } finally {
    page.off("framenavigated", onNavigation);
  }
}
