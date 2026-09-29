import type { BrowserContext, Page } from "playwright";
import type { EffectiveAuditCase, ReadyState } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";

interface GuardState {
  readonly url: string;
  readonly readyCondition: { readonly selector: string; readonly state: ReadyState } | null;
}

type EvaluationRequest =
  | { readonly kind: "start" }
  | { readonly kind: "finish" }
  | { readonly kind: "evaluate"; readonly source: string; readonly isFunction: boolean; readonly argument: unknown };

interface ReadyNode {
  readonly nodeType: number;
  readonly parentNode: ReadyElement | null;
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
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly value?: string;
  readonly type?: string;
  checkVisibility(): boolean;
  getBoundingClientRect(): { width: number; height: number };
  contains(node: unknown): boolean;
  getRootNode(): ReadyRoot;
  matches(selector: string): boolean;
  querySelectorAll(selector: string): readonly ReadyElement[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface GuardedDocument extends ReadyRoot {
  createRange(): { selectNode(node: ReadyNode): void; getBoundingClientRect(): { width: number; height: number } };
}

interface MutationEvidence {
  readonly type: string;
  readonly target: unknown;
  readonly attributeName?: string | null;
  readonly oldValue?: string | null;
  readonly removedNodes: Iterable<ReadyNode>;
  readonly addedNodes: Iterable<ReadyNode>;
}

interface GuardedValue {
  readonly value: unknown;
  readonly invalid: "url-mismatch" | "ready-lost" | "navigation-during-measurement" | null;
  readonly url: string;
}

interface InspectionInput {
  readonly request: EvaluationRequest;
  readonly guard: GuardState;
  readonly native: boolean;
  readonly recheck: boolean;
  readonly matches?: readonly ReadyElement[];
}

const PLAYWRIGHT_ENGINE_PREFIX = /^(?:text|xpath|role|nth|id|data-testid|data-test-id|data-test|alt|label|placeholder|title|testid|aria-ref)=/;
const PLAYWRIGHT_PSEUDO_CLASS = /:(?:has-text|text|above|below|left-of|right-of|near)\(|:visible(?![\w-])/;

interface SelectorSemantics {
  readonly native: boolean;
  readonly recheck: boolean;
}

function selectorSemantics(raw: string | null): SelectorSemantics {
  const css = raw !== null && raw.startsWith("css=") ? raw.slice(4) : raw;
  const text = css !== null && css.startsWith("text=") ? css.slice(5) : null;
  const recheck = css !== null && text === null &&
    (css.includes(">>") || PLAYWRIGHT_ENGINE_PREFIX.test(css) || PLAYWRIGHT_PSEUDO_CLASS.test(css));
  return { native: css !== null && text === null && !recheck, recheck };
}

async function inspectInPage(input: InspectionInput): Promise<GuardedValue> {
  const { request, guard } = input;
  const snapshot = input.matches ?? [];
  const global = globalThis as unknown as {
    location: { href: string };
    document: GuardedDocument;
    getComputedStyle(element: unknown): { visibility: string; display: string };
    MutationObserver: new (callback: (records: readonly MutationEvidence[]) => void) => { observe(root: unknown, options: unknown): void; disconnect(): void; takeRecords(): readonly MutationEvidence[] };
    history: { pushState: (...args: unknown[]) => unknown; replaceState: (...args: unknown[]) => unknown };
    addEventListener(type: string, callback: () => void): void;
    removeEventListener(type: string, callback: () => void): void;
    __vlintReadyRecheck?: (selector: string, state: ReadyState) => Promise<boolean>;
    __vlintRuleGuard?: {
      evaluate(request: Extract<EvaluationRequest, { kind: "evaluate" }>): Promise<GuardedValue>;
      finish(): Promise<GuardedValue>;
    };
  };
  if (request.kind !== "start") {
    const active = global.__vlintRuleGuard;
    if (active === undefined) throw new Error("measurement guard missing");
    return request.kind === "finish" ? active.finish() : active.evaluate(request);
  }
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
  const nativeSelector = input.native;
  const recheckViaPlaywright = input.recheck;
  const textValue = (element: ReadyElement): string => {
    if (element.nodeName === "INPUT") {
      const type = element.type ?? "";
      if (type === "submit" || type === "button" || type === "reset") return element.value ?? "";
    }
    return element.textContent ?? "";
  };
  const textMatches = (element: ReadyElement): boolean => {
    if (textQuery === null) return true;
    const text = textValue(element).replace(/\s+/g, " ").trim();
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
    if (selector === null || !nativeSelector) return true;
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
    const live = queryMatching().filter((element) => element.isConnected && stillMatches(element));
    if (state === "hidden") return !live.some((element) => isVisible(element));
    if (state === "attached") return live.length > 0;
    return live.some((element) => isVisible(element));
  };

  let invalid: GuardedValue["invalid"] = null;
  let invalidUrl = global.location.href;
  const playwrightReady = async (): Promise<boolean> => {
    if (rawSelector === null || typeof global.__vlintReadyRecheck !== "function") return true;
    try {
      return await global.__vlintReadyRecheck(rawSelector, state);
    } catch {
      return true;
    }
  };
  const pending: Array<Promise<void>> = [];
  const requestPlaywrightRecheck = (): void => {
    if (invalid !== null) return;
    pending.push(playwrightReady().then((ready) => {
      if (!ready && invalid === null) {
        invalid = "ready-lost";
        invalidUrl = global.location.href;
      }
    }));
  };
  const drain = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const verifyGuards = (): void => {
    if (invalid !== null) return;
    if (new URL(global.location.href).href !== guard.url) {
      invalid = "url-mismatch";
      invalidUrl = global.location.href;
      return;
    }
    if (recheckViaPlaywright) {
      requestPlaywrightRecheck();
      return;
    }
    if (!readySatisfied()) {
      invalid = "ready-lost";
      invalidUrl = global.location.href;
    }
  };

  const readyNodes = new Set(queryMatching().filter((element) => element.isConnected && stillMatches(element)));
  const visibleNodes = new Set(Array.from(readyNodes).filter(isVisible));
  const includesReady = (node: ReadyNode, element: ReadyElement): boolean => {
    const container = node as ReadyElement;
    let current = element;
    while (true) {
      if (node === current || container.contains?.(current)) return true;
      const host = current.getRootNode().host;
      if (host === undefined) return false;
      current = host;
    }
  };
  const elementsIn = (node: ReadyNode): ReadyElement[] => {
    const found: ReadyElement[] = [];
    const walk = (root: ReadyRoot): void => {
      for (const element of root.querySelectorAll("*")) {
        found.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    if (node.nodeType === 1) {
      const element = node as ReadyElement;
      found.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
      walk(element);
    }
    return found;
  };
  const couldMatch = (element: ReadyElement): boolean => {
    if (textQuery !== null) return textMatches(element);
    if (!nativeSelector || selector === null) return false;
    try { return element.matches(selector); } catch { return true; }
  };
  const markLost = (): void => { invalid = "ready-lost"; invalidUrl = global.location.href; };
  const complexSelector = nativeSelector && selector !== null && /[:\s>+~]/.test(selector);
  const inspectHistory = (records: readonly MutationEvidence[]): void => {
    for (let index = 0; index < records.length && invalid === null; index += 1) {
      const record = records[index]!;
      if (record.type === "childList") {
        const addedNodes = Array.from(record.addedNodes);
        const removedNodes = Array.from(record.removedNodes);
        if ([...addedNodes, ...removedNodes].some((node) => elementsIn(node).some((element) => element.shadowRoot))) { markLost(); break; }
        if (complexSelector) { markLost(); break; }
        const added = addedNodes.flatMap(elementsIn).filter(couldMatch);
        if (state === "hidden" && added.length > 0) { markLost(); break; }
        for (const element of added) {
          readyNodes.add(element);
          if (element.isConnected && isVisible(element)) visibleNodes.add(element);
        }
        for (const node of removedNodes) {
          for (const element of readyNodes) {
            if (!includesReady(node, element)) continue;
            readyNodes.delete(element);
            visibleNodes.delete(element);
          }
        }
        if (textQuery !== null && (added.length > 0 || removedNodes.some((node) => node.nodeType === 3 || elementsIn(node).length > 0))) {
          markLost(); break;
        }
        if (state !== "hidden" && (state === "attached" ? readyNodes.size === 0 : visibleNodes.size === 0)) markLost();
        continue;
      }
      if (record.type === "characterData") {
        if (textQuery !== null) markLost();
        continue;
      }
      if (record.type !== "attributes") continue;
      const element = record.target as ReadyElement;
      const name = record.attributeName ?? "";
      const affectsMatch = selector !== null && (name === "id" || name === "class" || selector.includes(name));
      const affectsReady = Array.from(readyNodes).some((ready) => includesReady(element, ready));
      if (state === "hidden") {
        if (affectsReady || complexSelector || (affectsMatch && (couldMatch(element) ||
          (name === "id" && selector === `#${record.oldValue}`) ||
          (name === "class" && record.oldValue?.split(/\s+/).some((value) => selector === `.${value}`))))) markLost();
        continue;
      }
      if (!affectsReady) {
        if (complexSelector) markLost();
        continue;
      }
      if (name === "hidden" && readyNodes.has(element) && state === "visible") {
        const next = records.slice(index + 1).find((later) => later.type === "attributes" && later.target === element && later.attributeName === name);
        const after = next === undefined ? element.getAttribute(name) : next.oldValue ?? null;
        if (after === null && element.isConnected && isVisible(element)) visibleNodes.add(element);
        else visibleNodes.delete(element);
      } else {
        for (const ready of readyNodes) {
          if (!includesReady(element, ready)) continue;
          if (affectsMatch) readyNodes.delete(ready);
          visibleNodes.delete(ready);
        }
      }
      if (state === "attached" ? readyNodes.size === 0 : visibleNodes.size === 0) markLost();
    }
  };

  const status = (value: unknown): GuardedValue => ({ value, invalid, url: invalid === null ? global.location.href : invalidUrl });
  const verify = async (): Promise<void> => {
    verifyGuards();
    if (recheckViaPlaywright) await drain();
  };
  if (recheckViaPlaywright) await verify();
  else verifyGuards();
  if (invalid !== null) return status(null);
  const observationOptions = { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true };
  const observedRoots = new Set<ReadyRoot>([global.document]);
  const observer = new global.MutationObserver((records) => {
    if (invalid === null && guard.readyCondition !== null) observeRoots();
    if (invalid === null && guard.readyCondition !== null && !recheckViaPlaywright) inspectHistory(records);
    if (recheckViaPlaywright) for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as ReadyElement;
        if (rawSelector?.includes(record.attributeName ?? "") || snapshot.some((ready) => includesReady(target, ready))) markLost();
      }
      if (record.type === "characterData" && rawSelector?.includes("text")) markLost();
      if (record.type === "childList" && (state === "hidden" ||
        [...record.addedNodes, ...record.removedNodes].some((node) => snapshot.some((ready) => includesReady(node, ready))))) markLost();
      requestPlaywrightRecheck();
    }
    if (!recheckViaPlaywright) verifyGuards();
  });
  const observeRoots = (): void => {
    eachRoot((root) => {
      if (observedRoots.has(root)) return;
      observer.observe(root, observationOptions);
      observedRoots.add(root);
    });
  };
  observer.observe(global.document, observationOptions);
  if (guard.readyCondition !== null) observeRoots();
  const pushState = global.history.pushState;
  const replaceState = global.history.replaceState;
  global.history.pushState = function (...values: unknown[]) { const result = pushState.apply(this, values); verifyGuards(); return result; };
  global.history.replaceState = function (...values: unknown[]) { const result = replaceState.apply(this, values); verifyGuards(); return result; };
  global.addEventListener("popstate", verifyGuards);
  global.addEventListener("hashchange", verifyGuards);
  const release = (): void => {
    observer.disconnect();
    global.history.pushState = pushState;
    global.history.replaceState = replaceState;
    global.removeEventListener("popstate", verifyGuards);
    global.removeEventListener("hashchange", verifyGuards);
  };
  global.__vlintRuleGuard = {
    evaluate: async (execution) => {
      await verify();
      if (invalid !== null) return status(null);
      const expression = (0, eval)(`(${execution.source})`) as (arg: unknown) => unknown;
      const value = await (execution.isFunction ? expression(execution.argument) : expression);
      await verify();
      return status(value);
    },
    finish: async () => {
      try {
        verifyGuards();
        observer.disconnect();
        if (recheckViaPlaywright) await drain();
        return status(null);
      } finally {
        release();
        delete global.__vlintRuleGuard;
      }
    },
  };
  return status(null);
}

const recheckContexts = new WeakSet<BrowserContext>();

async function readyWithPlaywright(page: Page, selector: string, state: ReadyState): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count();
  if (state === "attached") return count > 0;
  for (let index = 0; index < count; index += 1) {
    const visible = await locator.nth(index).isVisible();
    if (state === "hidden" && visible) return false;
    if (state === "visible" && visible) return true;
  }
  return state === "hidden";
}

async function ensureRecheck(page: Page): Promise<void> {
  const context = page.context();
  if (recheckContexts.has(context)) return;
  recheckContexts.add(context);
  try {
    await context.exposeBinding("__vlintReadyRecheck", (source, selector: string, state: ReadyState) =>
      readyWithPlaywright(source.page, selector, state));
  } catch {
    recheckContexts.delete(context);
  }
}

async function evaluateObserved(page: Page, guard: GuardState, request: EvaluationRequest): Promise<GuardedValue> {
  const semantics = selectorSemantics(guard.readyCondition?.selector ?? null);
  const input: InspectionInput = { request, guard, native: semantics.native, recheck: semantics.recheck };
  if (request.kind !== "start" || guard.readyCondition === null) return page.evaluate(inspectInPage, input);
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
  let started = false;
  const check = async (kind: "start" | "finish"): Promise<void> => {
    try {
      const result = await evaluateObserved(page, guard, { kind });
      if (kind === "start" && result.invalid === null) started = true;
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
    if (selectorSemantics(guard.readyCondition?.selector ?? null).recheck) await ensureRecheck(page);
    await check("start");
    const guarded = new Proxy(page, {
      get(source, property) {
        if (property !== "evaluate") return Reflect.get(source, property, source);
        return async (fn: unknown, argument?: unknown): Promise<unknown> => {
          const result = await evaluateObserved(source, guard, {
            kind: "evaluate",
            source: typeof fn === "string" ? fn : (fn as Function).toString(),
            isFunction: typeof fn !== "string",
            argument,
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
    } finally {
      if (started) await check("finish");
    }
    const observed = detected as GuardedValue | null;
    if (observed === null) {
      if (evaluationError !== null) throw evaluationError;
      return outcome;
    }
    const failure: Failure = {
      stage: observed.invalid === "ready-lost" ? "ready-condition" : "navigation",
      code: observed.invalid === "ready-lost" ? "ready-lost" : observed.invalid === "url-mismatch" ? "url-mismatch" : "navigation-during-measurement",
      message: observed.invalid === "ready-lost" ? "ready state was lost or could not be verified during measurement" : "page navigated during measurement",
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
