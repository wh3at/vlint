import type { Page } from "playwright";
import type { EffectiveAuditCase, ReadyState } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";

interface GuardState {
  readonly url: string;
  readonly readyCondition: { readonly selector: string; readonly state: ReadyState } | null;
}

interface EvaluationRequest {
  readonly source: string;
  readonly isFunction: boolean;
  readonly argument: unknown;
  readonly execute: boolean;
}

interface ReadyNode {
  readonly nodeType: number;
  readonly nextSibling: ReadyNode | null;
}

interface ReadyRoot {
  readonly host?: ReadyElement;
  querySelectorAll(selector: string): readonly ReadyElement[];
}

interface ReadyElement extends ReadyNode {
  readonly isConnected: boolean;
  readonly previousElementSibling: ReadyElement | null;
  readonly firstChild: ReadyNode | null;
  readonly shadowRoot?: ReadyRoot | null;
  readonly textContent: string | null;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number };
  contains(node: unknown): boolean;
  getRootNode(): ReadyRoot;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): readonly ReadyElement[];
}

interface GuardedDocument extends ReadyRoot {
  createRange(): { selectNode(node: ReadyNode): void; getBoundingClientRect(): { width: number; height: number } };
}

interface MutationEvidence {
  readonly type: string;
  readonly target: unknown;
  readonly attributeName?: string | null;
  readonly oldValue?: string | null;
  readonly removedNodes: Iterable<unknown>;
}

interface GuardedValue {
  readonly value: unknown;
  readonly invalid: "url-mismatch" | "ready-lost" | "navigation-during-measurement" | null;
  readonly url: string;
}

interface InspectionInput {
  readonly request: EvaluationRequest;
  readonly guard: GuardState;
  readonly matches?: readonly ReadyElement[];
}

async function inspectInPage(input: InspectionInput): Promise<GuardedValue> {
  const { request, guard } = input;
  const snapshot = input.matches ?? [];
  const global = globalThis as unknown as {
    location: { href: string };
    document: GuardedDocument;
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

  const rawSelector = guard.readyCondition?.selector ?? null;
  const selector = rawSelector?.startsWith("css=") ? rawSelector.slice(4) : rawSelector;
  const state: ReadyState = guard.readyCondition?.state ?? "visible";
  const textQuery = selector?.startsWith("text=") ? selector.slice(5) : null;
  const opaqueSelector = selector !== null && (textQuery !== null || selector.includes(">>") ||
    selector.includes("xpath=") || selector.includes(":has-text(") || selector.includes(":text(") ||
    selector.includes(":visible") || selector.includes("nth=") || selector.includes("role="));
  const nativeSelector = selector !== null && !opaqueSelector;
  const textMatches = (element: ReadyElement): boolean => {
    if (textQuery === null) return true;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (textQuery.startsWith('"') && textQuery.endsWith('"')) return text === textQuery.slice(1, -1).replace(/\s+/g, " ").trim();
    if (textQuery.startsWith("'") && textQuery.endsWith("'")) return text === textQuery.slice(1, -1).replace(/\s+/g, " ").trim();
    if (textQuery.startsWith("/")) {
      const closingSlash = textQuery.lastIndexOf("/");
      if (closingSlash <= 0) return true;
      try { return new RegExp(textQuery.slice(1, closingSlash), textQuery.slice(closingSlash + 1)).test(text); } catch { return true; }
    }
    return text.toLowerCase().includes(textQuery.replace(/\s+/g, " ").trim().toLowerCase());
  };
  const stillMatches = (element: ReadyElement): boolean => {
    if (textQuery !== null) return textMatches(element);
    if (!nativeSelector) return true;
    try { return element.matches(selector); } catch { return true; }
  };

  const eachRoot = (visit: (root: ReadyRoot) => void): void => {
    const walk = (root: ReadyRoot): void => {
      visit(root);
      for (const element of root.querySelectorAll("*")) {
        const shadow = element.shadowRoot;
        if (shadow !== undefined && shadow !== null) walk(shadow);
      }
    };
    walk(global.document);
  };

  const queryMatching = (): readonly ReadyElement[] => {
    if (selector === null || (!nativeSelector && textQuery === null)) return snapshot;
    const found: ReadyElement[] = [];
    eachRoot((root) => {
      if (textQuery !== null) {
        for (const element of root.querySelectorAll("*")) {
          if (textMatches(element) && !Array.from(element.querySelectorAll("*")).some(textMatches)) found.push(element);
        }
        return;
      }
      try {
        for (const element of root.querySelectorAll(selector)) found.push(element);
      } catch {
        return;
      }
    });
    return found;
  };

  const readySatisfied = (): boolean => {
    if (guard.readyCondition === null) return true;
    if (state === "hidden") return !queryMatching().some((element) => element.isConnected && textMatches(element) && isVisible(element));
    const live = snapshot.filter((element) => element.isConnected && stillMatches(element));
    if (state === "attached") return live.length > 0;
    return live.some((element) => isVisible(element));
  };

  let invalid: GuardedValue["invalid"] = null;
  let invalidUrl = global.location.href;
  const verifyGuards = (): void => {
    if (invalid !== null) return;
    if (new URL(global.location.href).href !== guard.url) {
      invalid = "url-mismatch";
      invalidUrl = global.location.href;
      return;
    }
    if (!readySatisfied()) {
      invalid = "ready-lost";
      invalidUrl = global.location.href;
    }
  };

  const touchesSnapshot = (node: unknown): boolean => snapshot.some((element) => {
    if (node === element) return true;
    const container = node as { contains?: (value: unknown) => boolean };
    if (typeof container.contains === "function" && container.contains(element)) return true;
    const host = element.getRootNode().host;
    return host !== undefined && (node === host || (typeof container.contains === "function" && container.contains(host)));
  });

  const removalTouchesSnapshot = (removedNodes: Iterable<unknown>): boolean => {
    for (const node of removedNodes) if (touchesSnapshot(node)) return true;
    return false;
  };

  const unobservableReadyLoss = (record: MutationEvidence): boolean => {
    if (guard.readyCondition === null) return false;
    if (record.type === "childList" && state !== "hidden" && snapshot.length === 1 && removalTouchesSnapshot(record.removedNodes)) return true;
    if (record.type !== "attributes") return false;
    const element = record.target as ReadyElement;
    const attribute = record.attributeName;
    const oldValue = record.oldValue ?? "";
    if (state === "hidden") {
      return nativeSelector && attribute === "id" && selector.startsWith("#") &&
        !selector.includes(" ") && oldValue === selector.slice(1) && isVisible(element);
    }
    if (state === "visible" && attribute === "style" && touchesSnapshot(element) &&
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i.test(oldValue)) return true;
    if (!nativeSelector || !snapshot.some((match) => match.isConnected && stillMatches(match))) return false;
    if (attribute === "id" && selector.startsWith("#") && !selector.includes(" ") &&
      touchesSnapshot(element) && oldValue !== selector.slice(1)) return true;
    if (attribute === "class" && selector.startsWith(".") && !selector.includes(" ") &&
      touchesSnapshot(element) && !oldValue.split(/\s+/).includes(selector.slice(1))) return true;
    const sibling = selector.match(/^\.([\w-]+)\s*\+\s*#[\w-]+$/);
    return attribute === "class" && sibling !== null &&
      snapshot.some((match) => match.previousElementSibling === element &&
        !oldValue.split(/\s+/).includes(sibling[1]!));
  };

  verifyGuards();
  if (invalid !== null || !request.execute) return { value: null, invalid, url: invalid === null ? global.location.href : invalidUrl };
  const observer = new global.MutationObserver((records) => {
    for (const record of records) {
      if (invalid !== null) break;
      if (unobservableReadyLoss(record)) {
        invalid = "ready-lost";
        invalidUrl = global.location.href;
      }
    }
    verifyGuards();
  });
  observer.observe(global.document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  for (const match of snapshot) {
    const root = match.getRootNode();
    if (root !== global.document) observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  }
  const pushState = global.history.pushState;
  const replaceState = global.history.replaceState;
  global.history.pushState = function (...values: unknown[]) { const result = pushState.apply(this, values); verifyGuards(); return result; };
  global.history.replaceState = function (...values: unknown[]) { const result = replaceState.apply(this, values); verifyGuards(); return result; };
  global.addEventListener("popstate", verifyGuards);
  global.addEventListener("hashchange", verifyGuards);
  try {
    const expression = (0, eval)(`(${request.source})`) as (arg: unknown) => unknown;
    const value = await (request.isFunction ? expression(request.argument) : expression);
    verifyGuards();
    return { value, invalid, url: invalid === null ? global.location.href : invalidUrl };
  } finally {
    observer.disconnect();
    global.history.pushState = pushState;
    global.history.replaceState = replaceState;
    global.removeEventListener("popstate", verifyGuards);
    global.removeEventListener("hashchange", verifyGuards);
  }
}

async function evaluateObserved(page: Page, guard: GuardState, request: EvaluationRequest): Promise<GuardedValue> {
  const input: InspectionInput = { request, guard };
  if (guard.readyCondition === null) return page.evaluate(inspectInPage, input);
  return page.locator(guard.readyCondition.selector).evaluateAll((matches, payload) => {
    const inspect = (0, eval)(`(${payload.script})`) as (value: InspectionInput) => Promise<GuardedValue>;
    return inspect({ ...payload.input, matches: matches as unknown as readonly ReadyElement[] });
  }, { input, script: inspectInPage.toString() });
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
      const result = await evaluateObserved(page, guard, { source: "null", isFunction: false, argument: null, execute: false });
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
          const result = await evaluateObserved(source, guard, {
            source: typeof fn === "string" ? fn : (fn as Function).toString(),
            isFunction: typeof fn !== "string",
            argument,
            execute: true,
          });
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
