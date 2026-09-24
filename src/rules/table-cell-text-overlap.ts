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
  function visibleRect(rect: Box, parent: Element): Box | null {
    let visible: Box | null = intersect(rect, { x: 0, y: 0, width: innerWidth, height: innerHeight });
    let positioned: Element | null = null;
    let containingBlock: Element | null = null;
    for (let ancestor: Element | null = parent; ancestor !== null; ancestor = ancestor.parentElement) {
      const position = getComputedStyle(ancestor).position;
      if (position !== "absolute" && position !== "fixed") continue;
      positioned = ancestor;
      for (let block = ancestor.parentElement; block !== null; block = block.parentElement) {
        const style = getComputedStyle(block);
        const containsLayout = style.contain.split(/\s+/).some((part) => ["layout", "paint", "content", "strict"].includes(part));
        if ((position === "absolute" && style.position !== "static") || style.transform !== "none" ||
            style.filter !== "none" || style.perspective !== "none" || containsLayout) {
          containingBlock = block;
          break;
        }
      }
      break;
    }
    for (let ancestor: Element | null = parent; ancestor !== null && visible !== null; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.matches('[role="tooltip"], [role="dialog"], [popover]')) return null;
      const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
      const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);
      const paintsInside = style.contain.split(/\s+/).some((part) => ["paint", "content", "strict"].includes(part));
      // A positioned descendant escapes overflow between it and its containing block.
      const escapesOverflow = positioned !== null && ancestor !== positioned &&
        ancestor.contains(positioned) && (containingBlock === null ||
          (ancestor !== containingBlock && containingBlock.contains(ancestor)));
      const clipHorizontal = (clipsX && !escapesOverflow) || paintsInside;
      const clipVertical = (clipsY && !escapesOverflow) || paintsInside;
      if (clipHorizontal || clipVertical) {
        const bounds = ancestor.getBoundingClientRect();
        const clip = {
          x: bounds.left + ancestor.clientLeft, y: bounds.top + ancestor.clientTop,
          width: ancestor.clientWidth, height: ancestor.clientHeight,
        };
        visible = intersect(visible, {
          x: clipHorizontal ? clip.x : visible.x,
          y: clipVertical ? clip.y : visible.y,
          width: clipHorizontal ? clip.width : visible.width,
          height: clipVertical ? clip.height : visible.height,
        });
      }
      // Range geometry is not clipped by clip-path. A zero-radius circle hides all text.
      if (/^circle\(0(?:\.0+)?(?:px|%)?(?:\s+at\s+[^)]+)?\)$/.test(style.clipPath)) return null;
      // Inset clips are rectangular.
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
  function direction(rect: Box, cellBox: Box): "left" | "right" | "above" | "below" | null {
    const sameHeight = rect.y < cellBox.y + cellBox.height && rect.y + rect.height > cellBox.y;
    if (sameHeight && rect.x >= cellBox.x + cellBox.width - 1) return "right";
    if (sameHeight && rect.x + rect.width <= cellBox.x + 1) return "left";
    const sameColumn = rect.x < cellBox.x + cellBox.width && rect.x + rect.width > cellBox.x;
    if (sameColumn && Math.abs(rect.y - (cellBox.y + cellBox.height)) <= 1) return "below";
    if (sameColumn && Math.abs(rect.y + rect.height - cellBox.y) <= 1) return "above";
    return null;
  }
  for (const cell of inspected) {
    const cellBox = box(cell.getBoundingClientRect());
    const peers = cells.filter((other) => other !== cell && scope(other) === scope(cell))
      .map((element) => {
        const rect = box(element.getBoundingClientRect());
        return { element, rect, direction: direction(rect, cellBox) };
      });
    // Restrict lateral comparisons to the nearest cell in each column at a given height.
    const neighbors = peers.filter((peer) => {
      const { rect, direction } = peer;
      if (direction === "right") {
        return !peers.some((between) => between !== peer && between.direction === "right" &&
          between.rect.y < rect.y + rect.height && between.rect.y + between.rect.height > rect.y &&
          between.rect.x < rect.x);
      }
      if (direction === "left") {
        return !peers.some((between) => between !== peer && between.direction === "left" &&
          between.rect.y < rect.y + rect.height && between.rect.y + between.rect.height > rect.y &&
          between.rect.x + between.rect.width > rect.x + rect.width);
      }
      return direction !== null;
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
        const visible = visibleRect(box(fragment), parent);
        if (visible === null) continue;
        for (const { element, rect, direction } of neighbors) {
          if (intersect(visible, rect) === null) continue;
          const distance = direction === "right"
            ? Math.min(visible.x + visible.width - rect.x, rect.width)
            : direction === "left"
              ? Math.min(rect.x + rect.width - visible.x, rect.width)
              : direction === "below"
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
