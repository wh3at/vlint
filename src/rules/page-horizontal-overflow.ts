import type { Page } from "playwright";
import type { EffectivePageHorizontalOverflowRule } from "../contracts/config";
import type {
  Geometry,
  OverflowComputedStyle,
  PageHorizontalOverflowViolation,
  RuleEvaluationOutcome,
} from "../contracts/evaluation";
import type { Failure, FailureCode } from "../contracts/failure";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  composeLocators,
  type ElementDescriptor,
} from "./locator";

export interface HorizontalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OverflowCandidate {
  readonly index: number;
  readonly ancestorIndices: readonly number[];
  readonly geometry: HorizontalRect;
  readonly breachPx: number;
  readonly containedByLocalBoundary: boolean;
  readonly descriptor: ElementDescriptor;
  readonly computedStyle: OverflowComputedStyle;
}

interface ExtractedOverflowPage {
  readonly viewportWidth: number;
  readonly rootScrollWidth: number;
  readonly elementsInspected: number;
  readonly candidates: readonly OverflowCandidate[];
  readonly fallback: {
    readonly geometry: HorizontalRect;
    readonly descriptor: ElementDescriptor;
    readonly computedStyle: OverflowComputedStyle;
  };
}

export function calculateRootOverflow(viewportWidth: number, rootScrollWidth: number): number {
  return Math.max(0, rootScrollWidth - viewportWidth);
}

export function calculateHorizontalBreach(
  rect: Pick<HorizontalRect, "x" | "width">,
  viewportLeft: number,
  viewportWidth: number,
): number {
  const viewportRight = viewportLeft + viewportWidth;
  return Math.max(0, viewportLeft - rect.x, rect.x + rect.width - viewportRight);
}

export function selectOverflowRepresentatives(
  candidates: readonly OverflowCandidate[],
  tolerancePx: number,
): readonly OverflowCandidate[] {
  const qualifying = candidates.filter(
    (candidate) => candidate.breachPx > tolerancePx && !candidate.containedByLocalBoundary,
  );
  const qualifyingIndices = new Set(qualifying.map((candidate) => candidate.index));
  return qualifying.filter(
    (candidate) => !candidate.ancestorIndices.some((index) => qualifyingIndices.has(index)),
  );
}

function roundFinite(value: number): number {
  return Number(value.toFixed(3));
}

function failure(code: FailureCode, message: string, rule: string, target: string | null): Failure {
  return {
    stage: "rule-evaluation",
    code,
    message,
    target,
    device: null,
    rule,
  };
}

function validExtraction(value: ExtractedOverflowPage): boolean {
  if (!Number.isFinite(value.viewportWidth) || !Number.isFinite(value.rootScrollWidth)) return false;
  if (!Number.isInteger(value.elementsInspected) || value.elementsInspected < 0) return false;
  if (
    ![
      value.fallback.geometry.x,
      value.fallback.geometry.y,
      value.fallback.geometry.width,
      value.fallback.geometry.height,
    ].every(Number.isFinite)
  ) {
    return false;
  }
  return value.candidates.every(
    (candidate) =>
      Number.isInteger(candidate.index) &&
      candidate.ancestorIndices.every(Number.isInteger) &&
      Number.isFinite(candidate.breachPx) &&
      [
        candidate.geometry.x,
        candidate.geometry.y,
        candidate.geometry.width,
        candidate.geometry.height,
      ].every(Number.isFinite),
  );
}

export async function evaluatePageHorizontalOverflow(
  page: Page,
  rule: EffectivePageHorizontalOverflowRule,
  targetName: string | null = null,
): Promise<RuleEvaluationOutcome<PageHorizontalOverflowViolation>> {
  let extracted: ExtractedOverflowPage;
  try {
    extracted = await page.evaluate(
      ({ tolerancePx, stableDataAttrs, semanticAttrs }) => {
        const root = document.documentElement;
        const body = document.body;
        const scrolling = document.scrollingElement ?? root;
        const viewportWidth = root.clientWidth;
        const rootScrollWidth = Math.max(scrolling.scrollWidth, root.scrollWidth, body?.scrollWidth ?? 0);
        const viewportLeft = window.scrollX;
        const viewportRight = viewportLeft + viewportWidth;

        const pathFor = (element: Element) => {
          const path: { tag: string; index: number }[] = [];
          let current: Element | null = element;
          while (current !== null) {
            const tag = current.localName.toLowerCase();
            let index = 1;
            let sibling = current.previousElementSibling;
            while (sibling !== null) {
              if (sibling.localName.toLowerCase() === tag) index += 1;
              sibling = sibling.previousElementSibling;
            }
            path.unshift({ tag, index });
            current = current.parentElement;
          }
          return path;
        };
        const descriptorFor = (element: Element) => {
          let stableDataAttribute: { name: string; value: string } | null = null;
          for (const name of stableDataAttrs) {
            const value = element.getAttribute(name);
            if (value !== null) {
              stableDataAttribute = { name, value };
              break;
            }
          }
          let semanticAttribute: { name: string; value: string } | null = null;
          for (const name of semanticAttrs) {
            const value = element.getAttribute(name);
            if (value !== null) {
              semanticAttribute = { name, value };
              break;
            }
          }
          return {
            tag: element.localName.toLowerCase(),
            id: element.id || null,
            stableDataAttribute,
            semanticAttribute,
            path: pathFor(element),
          };
        };
        const styleFor = (style: CSSStyleDeclaration) => ({
          display: style.display,
          position: style.position,
          boxSizing: style.boxSizing,
          width: style.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          whiteSpace: style.whiteSpace,
          overflowX: style.overflowX,
          flex: style.flex,
          flexBasis: style.flexBasis,
          flexGrow: style.flexGrow,
          flexShrink: style.flexShrink,
          gridTemplateColumns: style.gridTemplateColumns,
          gridAutoColumns: style.gridAutoColumns,
        });
        const rectFor = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
        };
        const breachFor = (rect: { x: number; width: number }) =>
          Math.max(0, viewportLeft - rect.x, rect.x + rect.width - viewportRight);

        if (Math.max(0, rootScrollWidth - viewportWidth) <= tolerancePx) {
          const style = getComputedStyle(scrolling);
          return {
            viewportWidth,
            rootScrollWidth,
            elementsInspected: 0,
            candidates: [],
            fallback: { geometry: rectFor(scrolling), descriptor: descriptorFor(scrolling), computedStyle: styleFor(style) },
          };
        }

        const elements = Array.from(document.querySelectorAll("*"));
        const indexByElement = new Map(elements.map((element, index) => [element, index]));
        const rendered = new Map<Element, boolean>();
        const activeBoundaries = new Map<Element, { withinViewport: boolean }>();
        let elementsInspected = 0;

        for (const element of elements) {
          const style = getComputedStyle(element);
          const isRendered =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            element.getClientRects().length > 0;
          rendered.set(element, isRendered);
          if (!isRendered) continue;
          elementsInspected += 1;
          if ((style.overflowX === "auto" || style.overflowX === "scroll") && element.scrollWidth > element.clientWidth + tolerancePx) {
            const rect = rectFor(element);
            activeBoundaries.set(element, {
              withinViewport: rect.x >= viewportLeft - tolerancePx && rect.x + rect.width <= viewportRight + tolerancePx,
            });
          }
        }

        const candidates = [];
        for (const element of elements) {
          if (!rendered.get(element) || element === root || element === body) continue;
          const geometry = rectFor(element);
          const breachPx = breachFor(geometry);
          if (breachPx <= tolerancePx) continue;
          let ancestor = element.parentElement;
          let containedByLocalBoundary = false;
          while (ancestor !== null) {
            const boundary = activeBoundaries.get(ancestor);
            if (boundary !== undefined) {
              containedByLocalBoundary = boundary.withinViewport;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          const style = getComputedStyle(element);
          const ancestorIndices = [];
          let parent = element.parentElement;
          while (parent !== null) {
            const parentIndex = indexByElement.get(parent);
            if (parentIndex !== undefined) ancestorIndices.push(parentIndex);
            parent = parent.parentElement;
          }
          candidates.push({
            index: indexByElement.get(element) ?? -1,
            ancestorIndices,
            geometry,
            breachPx,
            containedByLocalBoundary,
            descriptor: descriptorFor(element),
            computedStyle: styleFor(style),
          });
        }
        const fallbackStyle = getComputedStyle(scrolling);
        return {
          viewportWidth,
          rootScrollWidth,
          elementsInspected,
          candidates,
          fallback: {
            geometry: rectFor(scrolling),
            descriptor: descriptorFor(scrolling),
            computedStyle: styleFor(fallbackStyle),
          },
        };
      },
      {
        tolerancePx: rule.tolerancePx,
        stableDataAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
        semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
      },
    );
  } catch {
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: failure("rule-script-failed", "Horizontal overflow measurement could not read the page.", rule.name, targetName),
    };
  }

  if (!validExtraction(extracted)) {
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: failure("geometry-evaluation-failed", "Horizontal overflow measurement returned invalid geometry.", rule.name, targetName),
    };
  }

  const rootOverflowPx = calculateRootOverflow(extracted.viewportWidth, extracted.rootScrollWidth);
  if (rootOverflowPx <= rule.tolerancePx) {
    return { facts: { elementsInspected: 0, violations: [] }, failure: null };
  }

  const representatives = selectOverflowRepresentatives(extracted.candidates, rule.tolerancePx);
  const causes = representatives.length > 0
    ? representatives
    : [{
        ...extracted.fallback,
        index: -1,
        ancestorIndices: [],
        breachPx: rootOverflowPx,
        containedByLocalBoundary: false,
      }];
  if (causes.length > 100) {
    return {
      facts: { elementsInspected: extracted.elementsInspected, violations: [] },
      failure: failure(
        "diagnostic-field-too-large",
        "Horizontal overflow produced more than 100 attributed causes.",
        rule.name,
        targetName,
      ),
    };
  }
  const diagnosticBytes = new TextEncoder().encode(
    JSON.stringify(causes.map((cause) => cause.computedStyle)),
  ).byteLength;
  const hasOversizedStyle = causes.some((cause) =>
    Object.values(cause.computedStyle).some((value) => new TextEncoder().encode(value).byteLength > 1024),
  );
  if (hasOversizedStyle || diagnosticBytes > 16 * 1024) {
    return {
      facts: { elementsInspected: extracted.elementsInspected, violations: [] },
      failure: failure(
        "diagnostic-field-too-large",
        "Horizontal overflow CSS diagnostics exceed the supported size.",
        rule.name,
        targetName,
      ),
    };
  }
  const violations: PageHorizontalOverflowViolation[] = [];

  for (const cause of causes) {
    const selectors = [...composeLocators(cause.descriptor)];
    let locator: string | null;
    try {
      locator = await page.evaluate((candidates: string[]) => {
        for (const selector of candidates) {
          try {
            if (document.querySelectorAll(selector).length === 1) return selector;
          } catch {
            continue;
          }
        }
        return null;
      }, selectors);
    } catch {
      return {
        facts: { elementsInspected: extracted.elementsInspected, violations },
        failure: failure("rule-script-failed", "Horizontal overflow locator verification could not read the page.", rule.name, targetName),
      };
    }
    if (locator === null) {
      return {
        facts: { elementsInspected: extracted.elementsInspected, violations },
        failure: failure("geometry-evaluation-failed", "Horizontal overflow cause no longer resolves uniquely.", rule.name, targetName),
      };
    }
    const geometry: Geometry = {
      x: roundFinite(cause.geometry.x),
      y: roundFinite(cause.geometry.y),
      width: roundFinite(cause.geometry.width),
      height: roundFinite(cause.geometry.height),
    };
    violations.push({
      type: "page-horizontal-overflow",
      overflowPx: roundFinite(cause.breachPx),
      geometry,
      locator,
      computedStyle: cause.computedStyle,
    });
  }

  return {
    facts: { elementsInspected: extracted.elementsInspected, violations },
    failure: null,
  };
}
