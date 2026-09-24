/// <reference lib="dom" />

import type { Page } from "playwright";
import type { EffectiveTableCellTextOverlapRule } from "../contracts/config";
import type { Geometry, RuleEvaluationOutcome, TableCellTextOverlapViolation } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  composeLocators,
  type ElementDescriptor,
} from "./locator";

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
interface Overlap {
  readonly cell: ElementDescriptor;
  readonly adjacent: ElementDescriptor;
  readonly geometry: Box;
  readonly overlapPx: number;
}
interface Extraction {
  readonly elementsInspected: number;
  readonly overlaps: readonly Overlap[];
  readonly selectorError: string | null;
}

function extract({ excludeSelectors, stableAttrs, semanticAttrs }: {
  excludeSelectors: readonly string[];
  stableAttrs: readonly string[];
  semanticAttrs: readonly string[];
}): Extraction {
  function box(rect: DOMRect): Box {
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  function intersect(a: Box, b: Box): Box | null {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  function descriptor(element: Element): ElementDescriptor {
    const attribute = (names: readonly string[]) => {
      for (const name of names) {
        const value = element.getAttribute(name);
        if (value !== null) return { name, value };
      }
      return null;
    };
    const path: { tag: string; index: number }[] = [];
    let current: Element | null = element;
    while (current !== null) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling !== null) {
        if (sibling.localName === current.localName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      path.unshift({ tag: current.localName.toLowerCase(), index });
      current = current.parentElement;
    }
    return {
      tag: element.localName.toLowerCase(), id: element.id || null,
      stableDataAttribute: attribute(stableAttrs), semanticAttribute: attribute(semanticAttrs), path,
    };
  }
  function rendered(element: Element): boolean {
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          style.contentVisibility === "hidden" || Number.parseFloat(style.opacity) <= 0) return false;
    }
    return element.getClientRects().length > 0;
  }
  function visibleRect(rect: Box, parent: Element, cell: Element): Box | null {
    let visible: Box | null = intersect(rect, { x: 0, y: 0, width: innerWidth, height: innerHeight });
    const source = cell.getBoundingClientRect();
    for (let ancestor: Element | null = parent; ancestor !== null && visible !== null; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor !== cell && cell.contains(ancestor) && (style.position === "absolute" || style.position === "fixed")) {
        // Body text may be positioned, but a separate overlay starts outside the source cell.
        const positioned = ancestor.getBoundingClientRect();
        if (positioned.left < source.left - 1 || positioned.left >= source.right ||
            positioned.top < source.top - 1 || positioned.top >= source.bottom ||
            ancestor.matches('[role="tooltip"], [role="dialog"], [popover]')) return null;
      }
      const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
      const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
      const paintsInside = style.contain.split(/\s+/).some((part) => ["paint", "content", "strict"].includes(part));
      if (clipsX || clipsY || paintsInside) {
        const bounds = ancestor.getBoundingClientRect();
        const clip = {
          x: bounds.left + ancestor.clientLeft, y: bounds.top + ancestor.clientTop,
          width: ancestor.clientWidth, height: ancestor.clientHeight,
        };
        visible = intersect(visible, {
          x: clipsX || paintsInside ? clip.x : visible.x,
          y: clipsY || paintsInside ? clip.y : visible.y,
          width: clipsX || paintsInside ? clip.width : visible.width,
          height: clipsY || paintsInside ? clip.height : visible.height,
        });
      }
      // Range geometry is not clipped by clip-path. Inset clips are rectangular.
      const inset = /^inset\(([^()]+)\)$/.exec(style.clipPath);
      if (inset !== null && visible !== null) {
        const bounds = ancestor.getBoundingClientRect();
        const values = inset[1]!.split(/\s+/).map((part, index) => {
          const size = index % 2 === 0 ? bounds.height : bounds.width;
          return part.endsWith("%") ? Number.parseFloat(part) * size / 100 : Number.parseFloat(part);
        });
        const top = values[0] ?? 0;
        const right = values[1] ?? top;
        const bottom = values[2] ?? top;
        const left = values[3] ?? right;
        visible = intersect(visible, {
          x: bounds.left + left, y: bounds.top + top,
          width: bounds.width - left - right, height: bounds.height - top - bottom,
        });
      }
    }
    return visible;
  }
  for (const selector of excludeSelectors) {
    try { document.querySelectorAll(selector); }
    catch { return { elementsInspected: 0, overlaps: [], selectorError: selector }; }
  }
  const candidates = Array.from(document.querySelectorAll('table th, table td, [role="table"] [role="cell"], [role="table"] [role="rowheader"], [role="table"] [role="columnheader"], [role="grid"] [role="gridcell"], [role="grid"] [role="rowheader"], [role="grid"] [role="columnheader"]'));
  const scope = (cell: Element) => cell.closest('table, [role="table"], [role="grid"]');
  const row = (cell: Element) => cell.closest('tr, [role="row"]');
  const cells = candidates.filter((cell) => scope(cell) !== null && row(cell) !== null && rendered(cell));
  const inspected = cells.filter((cell) => !excludeSelectors.some((selector) => cell.matches(selector)));
  const overlaps: Overlap[] = [];
  for (const cell of inspected) {
    const cellBox = box(cell.getBoundingClientRect());
    const peers = cells.filter((other) => other !== cell && scope(other) === scope(cell))
      .map((element) => ({ element, rect: box(element.getBoundingClientRect()) }));
    // Restrict lateral comparisons to the nearest cell in each column at a given height.
    const neighbors = peers.filter(({ rect }) => {
      const sameHeight = rect.y < cellBox.y + cellBox.height && rect.y + rect.height > cellBox.y;
      if (sameHeight && rect.x >= cellBox.x + cellBox.width - 1) {
        return !peers.some(({ rect: between }) => between !== rect &&
          between.y < rect.y + rect.height && between.y + between.height > rect.y &&
          between.x >= cellBox.x + cellBox.width - 1 && between.x < rect.x);
      }
      if (sameHeight && rect.x + rect.width <= cellBox.x + 1) {
        return !peers.some(({ rect: between }) => between !== rect &&
          between.y < rect.y + rect.height && between.y + between.height > rect.y &&
          between.x + between.width <= cellBox.x + 1 && between.x + between.width > rect.x + rect.width);
      }
      const sameColumn = rect.x < cellBox.x + cellBox.width && rect.x + rect.width > cellBox.x;
      return sameColumn && (Math.abs(rect.y - (cellBox.y + cellBox.height)) <= 1 ||
        Math.abs(rect.y + rect.height - cellBox.y) <= 1);
    });
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const breaches = new Map<Element, number>();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      const parent = text.parentElement;
      if (parent === null || !text.nodeValue?.trim() || !rendered(parent)) continue;
      const ink = getComputedStyle(parent).webkitTextFillColor || getComputedStyle(parent).color;
      if (ink === "transparent" || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(ink)) continue;
      // Nested tables/grids belong to their own cells, not the containing cell.
      if (parent.closest('th, td, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]') !== cell) continue;
      range.selectNodeContents(text);
      for (const fragment of range.getClientRects()) {
        if (fragment.width <= 0 || fragment.height <= 0) continue;
        const visible = visibleRect(box(fragment), parent, cell);
        if (visible === null) continue;
        for (const { element, rect } of neighbors) {
          if (intersect(visible, rect) === null) continue;
          const distance = rect.x >= cellBox.x + cellBox.width - 1
            ? Math.min(visible.x + visible.width - rect.x, rect.width)
            : rect.x + rect.width <= cellBox.x + 1
              ? Math.min(rect.x + rect.width - visible.x, rect.width)
              : rect.y >= cellBox.y + cellBox.height - 1
                ? Math.min(visible.y + visible.height - rect.y, rect.height)
                : Math.min(rect.y + rect.height - visible.y, rect.height);
          breaches.set(element, Math.max(breaches.get(element) ?? 0, distance));
        }
      }
    }
    for (const [adjacent, overlapPx] of breaches) {
      if (overlapPx > 1) overlaps.push({ cell: descriptor(cell), adjacent: descriptor(adjacent), geometry: cellBox, overlapPx });
    }
  }
  return { elementsInspected: inspected.length, overlaps, selectorError: null };
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }

export async function evaluateTableCellTextOverlap(
  page: Page,
  rule: EffectiveTableCellTextOverlapRule,
  target: string | null = null,
): Promise<RuleEvaluationOutcome<TableCellTextOverlapViolation>> {
  function failure(code: "rule-script-failed" | "exclude-selector-invalid" | "geometry-evaluation-failed", message: string): Failure {
    return { stage: "rule-evaluation", code, message, target, device: null, rule: rule.name };
  }
  let data: Extraction;
  try {
    data = await page.evaluate(extract, {
      excludeSelectors: rule.excludeSelectors,
      stableAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
      semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
    });
  } catch {
    return { facts: { elementsInspected: 0, violations: [] }, failure: failure("rule-script-failed", "Table-cell text measurement could not read the page.") };
  }
  if (data.selectorError !== null) {
    return { facts: { elementsInspected: 0, violations: [] }, failure: failure("exclude-selector-invalid", `Invalid exclude selector "${data.selectorError}".`) };
  }
  const descriptions = data.overlaps.flatMap((item) => [item.cell, item.adjacent]);
  let locators: (string | null)[];
  try {
    locators = await page.evaluate((lists: string[][]) => lists.map((selectors) =>
      selectors.find((selector) => {
        try { return document.querySelectorAll(selector).length === 1; }
        catch { return false; }
      }) ?? null), descriptions.map((item) => [...composeLocators(item)]));
  } catch {
    return { facts: { elementsInspected: data.elementsInspected, violations: [] }, failure: failure("rule-script-failed", "Table-cell locator verification could not read the page.") };
  }
  if (locators.some((item) => item === null)) {
    return { facts: { elementsInspected: data.elementsInspected, violations: [] }, failure: failure("geometry-evaluation-failed", "Table-cell locator no longer resolves uniquely.") };
  }
  const violations: TableCellTextOverlapViolation[] = data.overlaps.map((item, index) => ({
    type: "table-cell-text-overlap", locator: locators[index * 2]!, adjacentLocator: locators[index * 2 + 1]!,
    geometry: { x: round(item.geometry.x), y: round(item.geometry.y), width: round(item.geometry.width), height: round(item.geometry.height) } as Geometry,
    overlapPx: round(item.overlapPx),
  }));
  return { facts: { elementsInspected: data.elementsInspected, violations }, failure: null };
}
