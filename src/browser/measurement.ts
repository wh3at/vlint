import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import type { EffectiveAuditCase, ReadyState } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";

interface GuardState {
  readonly url: string;
  readonly readyCondition: { readonly selector: string; readonly state: ReadyState } | null;
  readonly slot: string;
  recheckBinding: string | null;
}

type EvaluationRequest =
  | { readonly kind: "start" }
  | { readonly kind: "finish" }
  | { readonly kind: "evaluate"; readonly source: string; readonly isFunction: boolean; readonly argument: unknown };

interface ReadyNode {
  readonly nodeType: number;
  readonly parentNode: ReadyElement | null;
  readonly nextSibling: ReadyNode | null;
  readonly textContent: string | null;
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
  readonly implementation: { createHTMLDocument(): { importNode(node: ReadyElement, deep: boolean): ReadyElement } };
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

interface RuleGuard {
  evaluate(request: Extract<EvaluationRequest, { kind: "evaluate" }>): Promise<GuardedValue>;
  finish(): Promise<GuardedValue>;
}

interface InspectionInput {
  readonly request: EvaluationRequest;
  readonly guard: GuardState;
  readonly native: boolean;
  readonly recheck: boolean;
  readonly matches?: readonly ReadyElement[];
  readonly buttonCandidates?: readonly ReadyElement[];
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
    Element: { prototype: { attachShadow: (this: ReadyElement, options: { mode: string }) => ReadyRoot } };
  };
  const slots = globalThis as unknown as Record<string, RuleGuard | undefined>;
  if (request.kind !== "start") {
    const active = slots[guard.slot];
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
  const recheckViaPlaywright = input.recheck || (nativeSelector && selector !== null &&
    snapshot.some((element) => {
      try { return !element.matches(selector); } catch { return true; }
    }));
  const skippedForText = (element: ReadyElement): boolean =>
    element.nodeName === "SCRIPT" || element.nodeName === "STYLE" || element.nodeName === "NOSCRIPT" || element.nodeName === "HEAD";
  let textOverrides: Map<ReadyNode, string> | null = null;
  const textValue = (element: ReadyElement): string => {
    if (skippedForText(element)) return "";
    if (element.nodeName === "INPUT") {
      const type = element.type ?? "";
      if (type === "submit" || type === "button" || type === "reset") return element.value ?? "";
    }
    let value = "";
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 3) value += textOverrides?.get(child) ?? child.textContent ?? "";
      else if (child.nodeType === 1) value += textValue(child as ReadyElement);
    }
    return value;
  };
  const textMatches = (element: ReadyElement): boolean => {
    if (textQuery === null) return true;
    for (let ancestor: ReadyElement | null = element; ancestor !== null; ancestor = ancestor.parentNode) {
      if (skippedForText(ancestor)) return false;
    }
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
    if (selector === null || !nativeSelector || recheckViaPlaywright) return true;
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
    if (selector === null || recheckViaPlaywright || (!nativeSelector && textQuery === null)) return snapshot;
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
    if (rawSelector === null) return true;
    const binding = guard.recheckBinding === null ? undefined : (globalThis as unknown as Record<string, unknown>)[guard.recheckBinding];
    if (typeof binding !== "function") return false;
    try {
      return await binding(rawSelector, state);
    } catch {
      return false;
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
  const matchingElementsIn = (nodes: readonly ReadyNode[]): ReadyElement[] => nodes.flatMap(elementsIn).filter(couldMatch);
  const markLost = (): void => { invalid = "ready-lost"; invalidUrl = global.location.href; };
  const complexSelector = nativeSelector && selector !== null && /[:\s>+~]/.test(selector);
  const xpathSelector = selector !== null && (selector.startsWith("xpath=") || selector.startsWith("//") || selector.startsWith(".."));
  const selfPredicateXPath = selector !== null &&
    /^(?:xpath=)?\/\/[a-zA-Z_][\w-]*(?:\[@[\w-]+(?:=(?:"[^"]*"|'[^']*'))?\])*$/.test(selector);
  const relationalSelector = selector !== null && (selector.includes(">>") ||
    (xpathSelector && !selfPredicateXPath));
  const hasScope = selector?.match(/^([a-zA-Z][\w-]*|[.#][a-zA-Z_][\w-]*):has\(([a-zA-Z][\w-]*|[.#][a-zA-Z_][\w-]*)\)(?:\s*[>+~]?\s*[a-zA-Z#.][\w.-]*)*$/) ?? null;
  const findHasAnchors = (): ReadyElement[] => {
    const anchors: ReadyElement[] = [];
    if (hasScope !== null) eachRoot((root) => { for (const element of root.querySelectorAll(hasScope[1]!)) anchors.push(element); });
    return anchors;
  };
  const hasAnchors = findHasAnchors();
  const readyDependsOnVisibility = state !== "attached";
  const changesStylesheet = (target: ReadyNode, changed: readonly ReadyNode[]): boolean => readyDependsOnVisibility &&
    (changed.some((node) => elementsIn(node).some((element) => element.nodeName === "STYLE" || element.nodeName === "LINK")) ||
      (target.nodeType === 1 && ((target as ReadyElement).nodeName === "STYLE" || (target as ReadyElement).nodeName === "LINK")));
  const affectsComplexReady = (target: ReadyNode, changed: readonly ReadyNode[]): boolean => {
    if (changesStylesheet(target, changed)) return true;
    if (Array.from(readyNodes).some((ready) => target === ready ||
      changed.some((node) => includesReady(node, ready)) ||
      (target === ready.parentNode && /[+~]|:nth-/.test(selector ?? "")))) return true;
    if (!selector?.includes(":has(")) return state === "hidden";
    if (hasScope === null) return true;
    const anchors = [...hasAnchors, ...findHasAnchors()];
    if (changed.some((node) => elementsIn(node).some((element) => element.matches(hasScope[1]!)))) return true;
    return anchors.some((anchor) => includesReady(anchor, target as ReadyElement) &&
      changed.some((node) => elementsIn(node).some((element) => element.matches(hasScope[2]!))));
  };
  const attributeDependency = (css: string, name: string, before: string | null, after: string | null): boolean => {
    if (css.includes("\\") || css.includes("/*") || css.includes("|") || css.includes("@import") || /:(?!has\(|is\(|where\(|not\()[\w-]+/.test(css)) return true;
    const attributes = Array.from(css.matchAll(/\[\s*([-\w:]+)/g));
    if ((css.includes("[") && attributes.length === 0) || attributes.some((match) => match[1]!.toLowerCase() === name.toLowerCase())) return true;
    const values = `${before ?? ""} ${after ?? ""}`.split(/\s+/).filter(Boolean);
    if (name === "class") return values.some((value) => css.toLowerCase().includes(`.${value.toLowerCase()}`));
    if (name === "id") return values.some((value) => css.toLowerCase().includes(`#${value.toLowerCase()}`));
    return false;
  };
  const stylesheetDependency = (dependsOn: (css: string) => boolean): boolean => {
    if (!readyDependsOnVisibility) return false;
    let dependent = false;
    eachRoot((root) => {
      const sheets = root as unknown as { styleSheets?: Iterable<{ cssRules: Iterable<{ cssText: string }> }>; adoptedStyleSheets?: Iterable<{ cssRules: Iterable<{ cssText: string }> }> };
      try {
        for (const sheet of [...sheets.styleSheets ?? [], ...sheets.adoptedStyleSheets ?? []]) {
          for (const rule of sheet.cssRules) if (dependsOn(rule.cssText)) dependent = true;
        }
      } catch { dependent = true; }
    });
    return dependent;
  };
  const stylesheetAttributeDependency = (name: string, before: string | null, after: string | null): boolean =>
    stylesheetDependency((css) => attributeDependency(css, name, before, after));
  const stylesheetStructuralDependency = (): boolean => stylesheetDependency((css) =>
    css.includes("@") || Array.from(css.matchAll(/([^{}]+)\{/g)).some((match) => /[:+~]/.test(match[1]!)));
  const inspectHistory = (records: readonly MutationEvidence[]): void => {
    const attributeCopies = new Map<ReadyElement, ReadyElement>();
    const historicalParents = new Map<ReadyNode, ReadyNode | null>();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.type !== "childList") continue;
      for (const node of record.addedNodes) historicalParents.set(node, null);
      for (const node of record.removedNodes) historicalParents.set(node, record.target as ReadyNode);
    }
    const historicallyAttached = (element: ReadyElement): boolean => {
      for (let node: ReadyNode | null = element; node !== null;) {
        if (node === global.document as unknown as ReadyNode) return true;
        node = historicalParents.has(node) ? historicalParents.get(node)! :
          node.parentNode ?? (node as unknown as ReadyRoot).host ?? null;
      }
      return false;
    };
    const nextAttribute = new Map<MutationEvidence, string | null>();
    const attributeDocument = records.some((record) => record.type === "attributes") ? global.document.implementation.createHTMLDocument() : null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.type !== "attributes") continue;
      const target = record.target as ReadyElement;
      let copy = attributeCopies.get(target);
      if (copy === undefined) { copy = attributeDocument!.importNode(target, false); attributeCopies.set(target, copy); }
      const name = record.attributeName!;
      nextAttribute.set(record, copy.getAttribute(name));
      if (record.oldValue == null) copy.removeAttribute(name);
      else copy.setAttribute(name, record.oldValue);
    }
    const historicallyVisible = (element: ReadyElement): boolean => {
      for (let ancestor: ReadyElement | null = element; ancestor !== null; ancestor = ancestor.parentNode?.nodeType === 1 ? ancestor.parentNode : ancestor.getRootNode().host ?? null) {
        if (ancestor.nodeType !== 1) break;
        const copy = attributeCopies.get(ancestor);
        if (copy?.getAttribute("hidden") != null) return false;
        if (copy !== undefined && copy.getAttribute("style") !== ancestor.getAttribute("style")) return false;
      }
      return visibleNodes.has(element) || isVisible(element);
    };
    const unaffectedTextReady = textQuery !== null && state !== "hidden" &&
      Array.from(state === "attached" ? readyNodes : visibleNodes).some((ready) =>
        ready.isConnected && stillMatches(ready) && (state === "attached" || isVisible(ready)) &&
        records.every((record) => !includesReady(ready, record.target as ReadyElement) &&
          !(record.type === "attributes" && includesReady(record.target as ReadyNode, ready)) &&
          !(record.type === "childList" && Array.from(record.removedNodes).some((node) => includesReady(node, ready)))));
    const textHistory = new Map<ReadyNode, string>();
    const nextText = new Map<MutationEvidence, string>();
    if (textQuery !== null) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!;
        if (record.type !== "characterData") continue;
        const target = record.target as ReadyNode;
        nextText.set(record, textHistory.get(target) ?? target.textContent ?? "");
        textHistory.set(target, record.oldValue ?? "");
      }
    }
    for (let index = 0; index < records.length && invalid === null; index += 1) {
      const record = records[index]!;
      if (record.type === "childList") {
        const addedNodes = Array.from(record.addedNodes);
        const removedNodes = Array.from(record.removedNodes);
        for (const node of removedNodes) historicalParents.set(node, null);
        for (const node of addedNodes) historicalParents.set(node, record.target as ReadyNode);
        const changed = [...addedNodes, ...removedNodes];
        if (state === "hidden" && changed.some((node) => elementsIn(node).some((element) => element.shadowRoot && !observedRoots.has(element.shadowRoot)))) { markLost(); break; }
        if (changesStylesheet(record.target as ReadyNode, changed)) { markLost(); break; }
        if (complexSelector && affectsComplexReady(record.target as ReadyNode, changed)) { markLost(); break; }
        if (complexSelector) continue;
        const added = matchingElementsIn(addedNodes);
        textOverrides = textHistory;
        const insertionMatches = state === "hidden" && textQuery !== null ? matchingElementsIn(addedNodes) : added;
        textOverrides = null;
        if (state === "hidden" && insertionMatches.some((element) => !element.isConnected || isVisible(element))) { markLost(); break; }
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
        const unrelatedTextReplacement = unaffectedTextReady &&
          (record.target as ReadyNode).nodeType === 1 && !skippedForText(record.target as ReadyElement) &&
          [...addedNodes, ...removedNodes].every((node) => node.nodeType === 3);
        if (textQuery !== null && !unrelatedTextReplacement && (added.length > 0 || removedNodes.some((node) => node.nodeType === 3 || elementsIn(node).length > 0))) {
          markLost(); break;
        }
        if (state !== "hidden" && (state === "attached" ? readyNodes.size === 0 : visibleNodes.size === 0)) markLost();
        continue;
      }
      if (record.type === "characterData") {
        if (textQuery !== null) {
          textHistory.set(record.target as ReadyNode, nextText.get(record)!);
          textOverrides = textHistory;
          const satisfied = readySatisfied();
          textOverrides = null;
          if (!satisfied) markLost();
        }
        continue;
      }
      if (record.type !== "attributes") continue;
      const element = record.target as ReadyElement;
      const name = record.attributeName ?? "";
      const affectsMatch = selector !== null && (name === "id" || name === "class" || selector.includes(name));
      const affectsReady = Array.from(readyNodes).some((ready) => includesReady(element, ready));
      const copy = attributeCopies.get(element)!;
      const before = copy.getAttribute(name);
      const after = nextAttribute.get(record) ?? null;
      if (after === null) copy.removeAttribute(name);
      else copy.setAttribute(name, after);
      const selectorDependency = attributeDependency(selector ?? "", name, before, after);
      const styleDependency = stylesheetAttributeDependency(name, before, after);
      if (complexSelector && !affectsReady && !selectorDependency && !styleDependency && (name === "id" || name === "class")) continue;
      if (nativeSelector && !recheckViaPlaywright && !complexSelector && selectorDependency && !styleDependency && state !== "hidden") {
        if (historicallyAttached(element) && copy.matches(selector!)) {
          readyNodes.add(element);
          if (historicallyVisible(element)) visibleNodes.add(element);
          else visibleNodes.delete(element);
        } else {
          readyNodes.delete(element);
          visibleNodes.delete(element);
        }
        if (state === "attached" ? readyNodes.size === 0 : visibleNodes.size === 0) markLost();
        continue;
      }
      if (styleDependency && readyDependsOnVisibility) { markLost(); continue; }
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

  const bareRole = selector?.match(/^role=(progressbar|main|button)$/)?.[1] ?? null;
  const namedButton = selector?.match(/^role=button\[name=(["'])(.*?)\1\]$/)?.[2] ?? null;
  const roleCandidate = (element: ReadyElement): boolean => {
    const explicit = element.getAttribute("role");
    if (explicit?.toLowerCase().split(/\s+/).includes(bareRole ?? "")) return true;
    return (bareRole === "progressbar" && element.nodeName === "PROGRESS") ||
      (bareRole === "main" && element.nodeName === "MAIN") ||
      (bareRole === "button" && (element.nodeName === "BUTTON" || element.nodeName === "SUMMARY" ||
        (element.nodeName === "INPUT" && /^(button|submit|reset|image)$/.test(element.type ?? ""))));
  };
  const roleAncestor = (node: ReadyNode): boolean => {
    for (let element = node.nodeType === 1 ? node as ReadyElement : (node as unknown as ReadyRoot).host ?? node.parentNode; element !== null; element = element.parentNode?.nodeType === 1 ? element.parentNode : element.getRootNode().host ?? null) {
      if (element.nodeType !== 1) break;
      if (roleCandidate(element)) return true;
    }
    return false;
  };
  const inspectButtonTextHistory = (records: readonly MutationEvidence[]): void => {
    if (namedButton === null) return;
    const history = new Map<ReadyNode, string>();
    const next = new Map<MutationEvidence, string>();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.type !== "characterData") continue;
      const node = record.target as ReadyNode;
      next.set(record, history.get(node) ?? node.textContent ?? "");
      history.set(node, record.oldValue ?? "");
    }
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const candidates = new Set([...snapshot, ...input.buttonCandidates ?? []]);
    for (const record of records) {
      if (record.type !== "characterData") continue;
      history.set(record.target as ReadyNode, next.get(record)!);
      textOverrides = history;
      const matching = Array.from(candidates).filter((ready) => {
        const references = ready.getAttribute("aria-labelledby")?.split(/\s+/).flatMap((id) =>
          Array.from(ready.getRootNode().querySelectorAll("[id]")).filter((element) => element.getAttribute("id") === id)) ?? [];
        const label = ready.getAttribute("aria-label");
        const sources = references.length > 0 ? references : label?.trim() ? [] : [ready];
        if (!sources.some((source) => Array.from(history.keys()).some((node) => includesReady(source, node as ReadyElement)))) return snapshot.includes(ready);
        if (sources.some((source) => source.shadowRoot || source.querySelectorAll("*").length > 0)) return false;
        const name = sources.map(textValue).join(" ");
        return normalize(name) === normalize(namedButton);
      });
      textOverrides = null;
      const satisfied = state === "hidden" ? !matching.some(isVisible) :
        matching.some((ready) => ready.isConnected && (state === "attached" || isVisible(ready)));
      if (!satisfied) { markLost(); break; }
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
    if (invalid === null && guard.readyCondition !== null && !input.recheck) inspectHistory(records);
    if (input.recheck) inspectButtonTextHistory(records);
    if (input.recheck) for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target as ReadyElement;
        const name = record.attributeName ?? "";
        const matchedReady = snapshot.some((ready) => includesReady(target, ready));
        const hiddenCandidate = state === "hidden" && (bareRole === null ? rawSelector?.includes(name) === true :
          (name === "role" && record.oldValue?.split(/\s+/).includes(bareRole)) ||
          elementsIn(target).some(roleCandidate) || roleAncestor(target) ||
          stylesheetAttributeDependency(name, record.oldValue ?? null, target.getAttribute(name)));
        const dependencyCandidate = state !== "hidden" && relationalSelector && rawSelector?.includes(name) === true;
        if (matchedReady || hiddenCandidate || dependencyCandidate) markLost();
      }
      if (record.type === "characterData" && (rawSelector?.includes("text") ||
        (rawSelector?.startsWith("role=") && rawSelector.includes("[name=") && namedButton === null) ||
        (state === "hidden" && bareRole !== null && roleAncestor(record.target as ReadyNode)))) markLost();
      if (record.type === "childList") {
        const changed = [...record.addedNodes, ...record.removedNodes];
        const hiddenCandidate = state === "hidden" && (bareRole === null || changed.flatMap(elementsIn).some((element) =>
          roleCandidate(element) || (element.shadowRoot && !observedRoots.has(element.shadowRoot))) ||
          roleAncestor(record.target as ReadyNode) || changesStylesheet(record.target as ReadyNode, changed) || stylesheetStructuralDependency());
        if (hiddenCandidate || changed.some((node) => snapshot.some((ready) => includesReady(node, ready)))) markLost();
      }
      requestPlaywrightRecheck();
    }
    if (invalid === null && guard.readyCondition !== null) observeRoots();
    if (!input.recheck) verifyGuards();
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
  const attachShadow = global.Element.prototype.attachShadow;
  let active = true;
  const guardedAttachShadow = function (this: ReadyElement, ...args: Parameters<typeof attachShadow>): ReadyRoot {
    const root = attachShadow.apply(this, args);
    if (active && guard.readyCondition !== null && this.isConnected && this.shadowRoot === root) {
      observer.observe(root, observationOptions);
      observedRoots.add(root);
    }
    return root;
  };
  if (guard.readyCondition !== null) global.Element.prototype.attachShadow = guardedAttachShadow;
  const pushState = global.history.pushState;
  const replaceState = global.history.replaceState;
  const guardedPushState = function (this: typeof global.history, ...values: unknown[]) { const result = pushState.apply(this, values); verifyGuards(); return result; };
  const guardedReplaceState = function (this: typeof global.history, ...values: unknown[]) { const result = replaceState.apply(this, values); verifyGuards(); return result; };
  global.history.pushState = guardedPushState;
  global.history.replaceState = guardedReplaceState;
  global.addEventListener("popstate", verifyGuards);
  global.addEventListener("hashchange", verifyGuards);
  const release = (): void => {
    active = false;
    if (global.Element.prototype.attachShadow === guardedAttachShadow) global.Element.prototype.attachShadow = attachShadow;
    observer.disconnect();
    if (global.history.pushState === guardedPushState) global.history.pushState = pushState;
    if (global.history.replaceState === guardedReplaceState) global.history.replaceState = replaceState;
    global.removeEventListener("popstate", verifyGuards);
    global.removeEventListener("hashchange", verifyGuards);
  };
  slots[guard.slot] = {
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
        delete slots[guard.slot];
      }
    },
  };
  return status(null);
}

const recheckContexts = new WeakMap<BrowserContext, Promise<string>>();

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

function ensureRecheck(page: Page): Promise<string> {
  const context = page.context();
  let installation = recheckContexts.get(context);
  if (installation === undefined) {
    const name = `__vlintReadyRecheck_${randomBytes(16).toString("hex")}`;
    installation = context.exposeBinding(name, (source, selector: string, state: ReadyState) =>
      readyWithPlaywright(source.page, selector, state)).then(() => name);
    recheckContexts.set(context, installation);
  }
  return installation;
}

async function evaluateObserved(page: Page, guard: GuardState, request: EvaluationRequest): Promise<GuardedValue> {
  const semantics = selectorSemantics(guard.readyCondition?.selector ?? null);
  const input: InspectionInput = { request, guard, native: semantics.native, recheck: semantics.recheck };
  if (request.kind !== "start" || guard.readyCondition === null) return page.evaluate(inspectInPage, input);
  const buttonCandidates = /^(?:css=)?role=button\[name=(["'])(.*?)\1\]$/.test(guard.readyCondition.selector) ?
    await page.locator("role=button").elementHandles() : [];
  try {
    return await page.locator(guard.readyCondition.selector).evaluateAll((matches, payload) => {
      const inspect = (0, eval)(`(${payload.script})`) as (value: InspectionInput) => Promise<GuardedValue>;
      return inspect({ ...payload.input, matches: matches as unknown as readonly ReadyElement[], buttonCandidates: payload.buttonCandidates as unknown as readonly ReadyElement[] });
    }, { input, script: inspectInPage.toString(), buttonCandidates });
  } finally {
    await Promise.all(buttonCandidates.map((candidate) => candidate.dispose()));
  }
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
    slot: `__vlintRuleGuard_${randomBytes(16).toString("hex")}`,
    recheckBinding: null,
  };
  let detected: GuardedValue | null = null;
  let started = false;
  const check = async (kind: "start" | "finish"): Promise<void> => {
    try {
      if (kind === "start" && guard.readyCondition !== null) guard.recheckBinding = await ensureRecheck(page);
      const result = await evaluateObserved(page, guard, { kind });
      if (kind === "start" && result.invalid === null) started = true;
      if (result.invalid !== null && detected === null) detected = result;
    } catch {
      if (detected === null) detected = { value: null, invalid: !sameUrl(page.url(), fixedUrl) ? "url-mismatch" : guard.readyCondition === null ? "navigation-during-measurement" : "ready-lost", url: page.url() };
    }
  };
  const onNavigation = (frame: import("playwright").Frame): void => {
    if (detected === null && frame === page.mainFrame()) detected = { value: null, invalid: sameUrl(frame.url(), fixedUrl) ? "navigation-during-measurement" : "url-mismatch", url: frame.url() };
  };
  page.on("framenavigated", onNavigation);
  try {
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
