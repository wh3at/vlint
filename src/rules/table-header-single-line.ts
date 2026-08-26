/// <reference lib="dom" />

import type { Page } from "playwright";
import type { EffectiveTableHeaderSingleLineRule } from "../contracts/config";
import type {
  Geometry,
  RuleEvaluationOutcome,
  TableHeaderCandidateDiagnostic,
  TableHeaderCandidateSource,
  TableHeaderSingleLineViolation,
} from "../contracts/evaluation";
import type { Failure, FailureCode } from "../contracts/failure";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  composeLocators,
  type ElementDescriptor,
} from "./locator";

export interface TableHeaderTextRect {
  readonly x: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}


function roundFinite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/** Cluster text rectangles against fixed visual-line anchors (KTD3). */
function sharesVisualLine(
  rect: TableHeaderTextRect,
  anchor: TableHeaderTextRect,
  tolerancePx: number,
): boolean {
  const topDistance = Math.abs(rect.top - anchor.top);
  const overlap =
    Math.min(rect.top + rect.height, anchor.top + anchor.height) -
    Math.max(rect.top, anchor.top);
  return (
    topDistance <= tolerancePx ||
    overlap >= Math.min(rect.height, anchor.height) / 2
  );
}
export function clusterTableHeaderLineTops(
  input: readonly TableHeaderTextRect[],
  tolerancePx: number,
): readonly number[] {
  const ordered = input
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect, index) => ({ rect, index }))
    .sort(
      (a, b) =>
        a.rect.top - b.rect.top || a.rect.x - b.rect.x || a.index - b.index,
    );
  const anchors: TableHeaderTextRect[] = [];
  for (const { rect } of ordered) {
    const matchesAnchor = anchors.some((anchor) =>
      sharesVisualLine(rect, anchor, tolerancePx),
    );
    if (!matchesAnchor) anchors.push(rect);
  }
  return anchors.map((anchor) => roundFinite(anchor.top));
}

interface InPageConfig {
  readonly additionalCandidateSelectors: readonly string[];
  readonly excludeSelectors: readonly string[];
  readonly stableDataAttrs: readonly string[];
  readonly semanticAttrs: readonly string[];
}

interface InPageSelectorError {
  readonly kind: "candidate" | "exclude";
  readonly selector: string;
  readonly message: string;
}

interface InPageRect {
  readonly x: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type InPageCandidate =
  | {
      readonly kind: "excluded";
      readonly descriptor: ElementDescriptor;
      readonly excludeSelector: string;
    }
  | {
      readonly kind: "generated-content-unmeasured";
      readonly descriptor: ElementDescriptor;
    }
  | {
      readonly kind: "measured";
      readonly source: TableHeaderCandidateSource;
      readonly descriptor: ElementDescriptor;
      readonly text: string;
      readonly rect: InPageRect;
      readonly fragments: readonly InPageRect[];
    }
  | { readonly kind: "skipped" };

interface InPageResult {
  readonly selectorError: InPageSelectorError | null;
  readonly candidates: readonly InPageCandidate[];
  readonly measurementError: { readonly index: number; readonly message: string } | null;
}

function tableHeaderExtractor(config: InPageConfig): InPageResult {
  const empty: InPageResult = { selectorError: null, candidates: [], measurementError: null };

  function probe(selector: string, kind: InPageSelectorError["kind"]): InPageSelectorError | null {
    try {
      document.querySelectorAll(selector);
      return null;
    } catch (error) {
      return {
        kind,
        selector,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  for (const selector of config.additionalCandidateSelectors) {
    const error = probe(selector, "candidate");
    if (error !== null) return { ...empty, selectorError: error };
  }
  for (const selector of config.excludeSelectors) {
    const error = probe(selector, "exclude");
    if (error !== null) return { ...empty, selectorError: error };
  }

  function isRendered(element: Element): boolean {
    if (!element.isConnected) return false;
    let current: Element | null = element;
    let opacity = 1;
    while (current !== null) {
      const style = getComputedStyle(current);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (style.contentVisibility === "hidden") return false;
      opacity *= Number.parseFloat(style.opacity);
      if (!(opacity > 0)) return false;
      current = current.parentElement;
    }
    return true;
  }

  function significantContent(content: string): boolean {
    return !["", "none", "normal", '""', "''"].includes(content);
  }

  function hasGeneratedContent(root: Element): boolean {
    const stack: Element[] = [root];
    while (stack.length > 0) {
      const element = stack.pop()!;
      if (isRendered(element)) {
        for (const pseudo of ["::before", "::after"] as const) {
          const style = getComputedStyle(element, pseudo);
          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            style.contentVisibility !== "hidden" &&
            Number.parseFloat(style.opacity) > 0 &&
            significantContent(style.content)
          ) {
            return true;
          }
        }
      }
      for (const child of element.children) stack.push(child);
    }
    return false;
  }

  function describeElement(element: Element): ElementDescriptor {
    const tag = element.tagName.toLowerCase();
    const rawId = element.getAttribute("id");
    const id = rawId !== null && rawId.length > 0 ? rawId : null;
    let stableDataAttribute: { name: string; value: string } | null = null;
    for (const name of config.stableDataAttrs) {
      const value = element.getAttribute(name);
      if (value !== null) {
        stableDataAttribute = { name, value };
        break;
      }
    }
    let semanticAttribute: { name: string; value: string } | null = null;
    for (const name of config.semanticAttrs) {
      const value = element.getAttribute(name);
      if (value !== null) {
        semanticAttribute = { name, value };
        break;
      }
    }
    const path: { tag: string; index: number }[] = [];
    let current: Element | null = element;
    while (current !== null) {
      const parent: Element | null = current.parentElement;
      let index = 1;
      if (parent !== null) {
        let sibling = parent.firstElementChild;
        while (sibling !== null && sibling !== current) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.nextElementSibling;
        }
      }
      path.push({ tag: current.tagName.toLowerCase(), index });
      current = parent;
    }
    path.reverse();
    return { tag, id, stableDataAttribute, semanticAttribute, path };
  }

  function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function extractTextRects(root: Element): InPageRect[] {
    const rects: InPageRect[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parent = node.parentElement;
      if (parent === null || !isRendered(parent)) continue;
      const value = node.nodeValue ?? "";
      const leading = value.length - value.replace(/^\s+/, "").length;
      const trailing = value.length - value.replace(/\s+$/, "").length;
      if (value.length - leading - trailing <= 0) continue;
      range.setStart(node, leading);
      range.setEnd(node, value.length - trailing);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        rects.push({ x: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
    }
    return rects;
  }

  function isRowHeader(element: Element): boolean {
    const role = element.getAttribute("role")?.toLowerCase();
    if (role === "rowheader") return true;
    if (element.tagName.toLowerCase() !== "th") return false;
    const scope = element.getAttribute("scope")?.toLowerCase();
    return scope === "row" || scope === "rowgroup";
  }

  function isNativeColumnHeader(element: Element): boolean {
    if (element.tagName.toLowerCase() !== "th" || isRowHeader(element)) return false;
    const scope = element.getAttribute("scope")?.toLowerCase();
    return scope === "col" || scope === "colgroup" || element.closest("thead") !== null;
  }

  function sourceFor(element: Element): TableHeaderCandidateSource {
    if (isNativeColumnHeader(element)) return "native";
    if (element.getAttribute("role")?.toLowerCase() === "columnheader") return "aria";
    return "additional";
  }

  const seen = new Set<Element>();
  const elements: Element[] = [];
  const selectors = [
    'th[scope="col"]',
    'th[scope="colgroup"]',
    "thead th",
    '[role="columnheader"]',
    ...config.additionalCandidateSelectors,
  ];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!seen.has(element)) {
        seen.add(element);
        elements.push(element);
      }
    }
  }
  elements.sort((left, right) => {
    if (left === right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const candidates: InPageCandidate[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    try {
      if (isRowHeader(element) || !isRendered(element)) {
        candidates.push({ kind: "skipped" });
        continue;
      }
      const descriptor = describeElement(element);
      const excludeSelector = config.excludeSelectors.find((selector) => element.matches(selector));
      if (excludeSelector !== undefined) {
        candidates.push({ kind: "excluded", descriptor, excludeSelector });
        continue;
      }
      if (hasGeneratedContent(element)) {
        candidates.push({ kind: "generated-content-unmeasured", descriptor });
        continue;
      }
      const source = sourceFor(element);
      const text = normalizeText((element as HTMLElement).innerText ?? "");
      const fragments = extractTextRects(element);
      if (text.length === 0 || fragments.length === 0) {
        candidates.push({ kind: "skipped" });
        continue;
      }
      const box = element.getBoundingClientRect();
      candidates.push({
        kind: "measured",
        source,
        descriptor,
        text,
        rect: { x: box.left, top: box.top, width: box.width, height: box.height },
        fragments,
      });
    } catch (error) {
      return {
        ...empty,
        candidates,
        measurementError: {
          index,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return { ...empty, candidates };
}

function failure(
  code: FailureCode,
  message: string,
  rule: EffectiveTableHeaderSingleLineRule,
  target: string | null,
): Failure {
  return {
    stage: "rule-evaluation",
    code,
    message,
    target,
    device: null,
    rule: rule.name,
  };
}

interface PendingViolation {
  readonly descriptor: ElementDescriptor;
  readonly source: TableHeaderCandidateSource;
  readonly geometry: Geometry;
  readonly text: string;
  readonly lineTops: readonly number[];
}

type PendingDiagnostic =
  | {
      readonly kind: "excluded";
      readonly descriptor: ElementDescriptor;
      readonly excludeSelector: string;
    }
  | {
      readonly kind: "generated-content-unmeasured";
      readonly descriptor: ElementDescriptor;
    };

async function resolveLocators(
  page: Page,
  descriptors: readonly ElementDescriptor[],
): Promise<readonly string[] | null> {
  if (descriptors.length === 0) return [];
  const candidates = descriptors.map((descriptor) => [...composeLocators(descriptor)]);
  try {
    const picks = await page.evaluate(
      (selectorLists: string[][]) =>
        selectorLists.map((selectors) => {
          for (const selector of selectors) {
            try {
              if (document.querySelectorAll(selector).length === 1) return selector;
            } catch {
              continue;
            }
          }
          return null;
        }),
      candidates,
    );
    return picks.map((pick, index) => pick ?? candidates[index]![candidates[index]!.length - 1]!);
  } catch {
    return null;
  }
}

export async function evaluateTableHeaderSingleLine(
  page: Page,
  rule: EffectiveTableHeaderSingleLineRule,
  targetName: string | null = null,
): Promise<RuleEvaluationOutcome<TableHeaderSingleLineViolation>> {
  let extracted: InPageResult;
  try {
    extracted = await page.evaluate(tableHeaderExtractor, {
      additionalCandidateSelectors: rule.additionalCandidateSelectors,
      excludeSelectors: rule.excludeSelectors,
      stableDataAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
      semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
    });
  } catch {
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: failure(
        "rule-script-failed",
        "Table-header measurement could not read the page (protocol rejection).",
        rule,
        targetName,
      ),
    };
  }

  if (extracted.selectorError !== null) {
    const error = extracted.selectorError;
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: failure(
        error.kind === "candidate" ? "candidate-selector-invalid" : "exclude-selector-invalid",
        `Invalid ${error.kind} selector "${error.selector}": ${error.message}`,
        rule,
        targetName,
      ),
    };
  }

  let elementsInspected = 0;
  const pendingViolations: PendingViolation[] = [];
  const pendingDiagnostics: PendingDiagnostic[] = [];
  for (const candidate of extracted.candidates) {
    if (candidate.kind === "excluded") {
      pendingDiagnostics.push({
        kind: candidate.kind,
        descriptor: candidate.descriptor,
        excludeSelector: candidate.excludeSelector,
      });
      continue;
    }
    if (candidate.kind === "generated-content-unmeasured") {
      pendingDiagnostics.push({ kind: candidate.kind, descriptor: candidate.descriptor });
      continue;
    }
    if (candidate.kind !== "measured") continue;
    elementsInspected += 1;
    const lineTops = clusterTableHeaderLineTops(candidate.fragments, rule.lineTopTolerancePx);
    if (lineTops.length >= 2) {
      pendingViolations.push({
        descriptor: candidate.descriptor,
        source: candidate.source,
        geometry: {
          x: roundFinite(candidate.rect.x),
          y: roundFinite(candidate.rect.top),
          width: roundFinite(candidate.rect.width),
          height: roundFinite(candidate.rect.height),
        },
        text: candidate.text,
        lineTops,
      });
    }
  }

  const descriptors = [
    ...pendingViolations.map((entry) => entry.descriptor),
    ...pendingDiagnostics.map((entry) => entry.descriptor),
  ];
  const locators = await resolveLocators(page, descriptors);
  if (locators === null) {
    return {
      facts: { elementsInspected, violations: [] },
      failure: failure(
        "rule-script-failed",
        "Table-header locator verification could not read the page (protocol rejection).",
        rule,
        targetName,
      ),
    };
  }

  const violations: TableHeaderSingleLineViolation[] = pendingViolations.map((entry, index) => ({
    type: "table-header-single-line",
    candidateSource: entry.source,
    locator: locators[index]!,
    geometry: entry.geometry,
    text: entry.text,
    lineCount: entry.lineTops.length,
    lineTops: entry.lineTops,
    lineTopTolerancePx: rule.lineTopTolerancePx,
  }));
  const diagnosticOffset = pendingViolations.length;
  const candidateDiagnostics: TableHeaderCandidateDiagnostic[] = pendingDiagnostics.map(
    (entry, index) =>
      entry.kind === "excluded"
        ? {
            kind: entry.kind,
            locator: locators[diagnosticOffset + index]!,
            excludeSelector: entry.excludeSelector,
          }
        : {
            kind: entry.kind,
            locator: locators[diagnosticOffset + index]!,
          },
  );
  const facts = {
    elementsInspected,
    violations,
    ...(candidateDiagnostics.length === 0 ? {} : { candidateDiagnostics }),
  };

  if (extracted.measurementError !== null) {
    return {
      facts,
      failure: failure(
        "geometry-evaluation-failed",
        `Table-header measurement failed at candidate #${extracted.measurementError.index}: ${extracted.measurementError.message}`,
        rule,
        targetName,
      ),
    };
  }
  if (elementsInspected < rule.minimumHeaders) {
    return {
      facts,
      failure: failure(
        "minimum-headers-unmet",
        `Inspected ${elementsInspected} header(s); minimum is ${rule.minimumHeaders}.`,
        rule,
        targetName,
      ),
    };
  }
  return { facts, failure: null };
}
