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
  // display, content-visibility, opacity and opacity filters hide the whole subtree.
  // visibility is inheritable and a descendant can restore it, so the text decides on its own value.
  function rendered(element: Element): boolean {
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.contentVisibility === "hidden" ||
          Number.parseFloat(style.opacity) <= 0 ||
          /\bopacity\(\s*0(?:\.0+)?%?\s*\)/.test(style.filter)) return false;
    }
    return getComputedStyle(element).display === "contents" || element.getClientRects().length > 0;
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
        // `inset(0 round 8px)` carries an optional border-radius clause that is not an offset.
        const parts = inset[1]!.replace(/\bround\b[\s\S]*$/, "").trim().split(/\s+/);
        const resolveInset = (part: string, size: number) =>
          part.endsWith("%") ? Number.parseFloat(part) * size / 100 : Number.parseFloat(part);
        const top = resolveInset(parts[0]!, bounds.height);
        const right = resolveInset(parts[1] ?? parts[0]!, bounds.width);
        const bottom = resolveInset(parts[2] ?? parts[0]!, bounds.height);
        const left = resolveInset(parts[3] ?? parts[1] ?? parts[0]!, bounds.width);
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
  const candidates = document.querySelectorAll('table th, table td, [role="table"] [role="cell"], [role="table"] [role="rowheader"], [role="table"] [role="columnheader"], [role="grid"] [role="gridcell"], [role="grid"] [role="rowheader"], [role="grid"] [role="columnheader"]');
  interface Cell { element: Element; rect: Box; group: { byX: Map<number, Cell[]>; byY: Map<number, Cell[]> } }
  const groups = new Map<Element, Cell["group"]>();
  const inspected: Cell[] = [];
  const bandSize = 64;
  function index(bands: Map<number, Cell[]>, start: number, size: number, cell: Cell): void {
    for (let band = Math.floor(start / bandSize); band <= Math.floor((start + size - 0.001) / bandSize); band++) {
      const entries = bands.get(band) ?? [];
      entries.push(cell);
      bands.set(band, entries);
    }
  }
  function nearby(bands: Map<number, Cell[]>, start: number, size: number): Set<Cell> {
    const found = new Set<Cell>();
    for (let band = Math.floor(start / bandSize); band <= Math.floor((start + size - 0.001) / bandSize); band++) {
      for (const cell of bands.get(band) ?? []) found.add(cell);
    }
    return found;
  }
  for (const element of candidates) {
    const scope = element.closest('table, [role="table"], [role="grid"]');
    if (scope === null || element.closest('tr, [role="row"]') === null || !rendered(element)) continue;
    let group = groups.get(scope);
    if (group === undefined) {
      group = { byX: new Map(), byY: new Map() };
      groups.set(scope, group);
    }
    const rect = box(element.getBoundingClientRect());
    const cell = { element, rect, group };
    index(group.byX, rect.x, rect.width, cell);
    index(group.byY, rect.y, rect.height, cell);
    if (!excludeSelectors.some((selector) => element.matches(selector))) inspected.push(cell);
  }
  const overlaps: Overlap[] = [];
  for (const { element: cell, rect: cellBox, group } of inspected) {
    const horizontal = [...nearby(group.byY, cellBox.y, cellBox.height)].filter((peer) => peer.element !== cell &&
      peer.rect.y < cellBox.y + cellBox.height && peer.rect.y + peer.rect.height > cellBox.y);
    const right = horizontal.filter(({ rect }) => rect.x >= cellBox.x + cellBox.width - 1)
      .sort((a, b) => a.rect.x - b.rect.x);
    const left = horizontal.filter(({ rect }) => rect.x + rect.width <= cellBox.x + 1)
      .sort((a, b) => b.rect.x + b.rect.width - a.rect.x - a.rect.width);
    // Keep the nearest cell at each height, including cells across a rowspan.
    const lateral = (peers: Cell[], edge: "left" | "right") => {
      const chosen: Cell[] = [];
      for (const peer of peers) {
        if (!chosen.some((between) =>
          (edge === "right" ? between.rect.x < peer.rect.x : between.rect.x + between.rect.width > peer.rect.x + peer.rect.width) &&
          between.rect.y < peer.rect.y + peer.rect.height && between.rect.y + between.rect.height > peer.rect.y)) chosen.push(peer);
      }
      return chosen;
    };
    const vertical = [...nearby(group.byX, cellBox.x, cellBox.width)].filter((peer) => peer.element !== cell &&
      peer.rect.x < cellBox.x + cellBox.width && peer.rect.x + peer.rect.width > cellBox.x);
    const below = vertical.filter(({ rect }) => rect.y >= cellBox.y + cellBox.height - 1)
      .sort((a, b) => a.rect.y - b.rect.y);
    const above = vertical.filter(({ rect }) => rect.y + rect.height <= cellBox.y + 1)
      .sort((a, b) => b.rect.y + b.rect.height - a.rect.y - a.rect.height);
    // A separated-border table has a gap between rows; keep the nearest cell in each column.
    const nearest = (peers: Cell[]) => {
      const chosen: Cell[] = [];
      for (const peer of peers) {
        if (!chosen.some((between) =>
          between.rect.x < peer.rect.x + peer.rect.width && between.rect.x + between.rect.width > peer.rect.x)) chosen.push(peer);
      }
      return chosen;
    };
    const neighbors = [
      ...lateral(right, "right").map((peer) => ({ ...peer, direction: "right" as const })),
      ...lateral(left, "left").map((peer) => ({ ...peer, direction: "left" as const })),
      ...nearest(below).map((peer) => ({ ...peer, direction: "below" as const })),
      ...nearest(above).map((peer) => ({ ...peer, direction: "above" as const })),
    ];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const breaches = new Map<Element, number>();
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      const parent = text.parentElement;
      if (parent === null || !text.nodeValue?.trim() || !rendered(parent)) continue;
      const style = getComputedStyle(parent);
      // A hidden cell or wrapper still paints a descendant that restores visibility.
      if (style.visibility === "hidden" || style.visibility === "collapse") continue;
      const ink = style.webkitTextFillColor || style.color;
      const transparent = (color: string) => color === "transparent" || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color);
      const shadow = style.textShadow !== "none" && !/^(?:transparent|(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\))\s/.test(style.textShadow);
      const stroke = Number.parseFloat(style.webkitTextStrokeWidth) > 0 && !transparent(style.webkitTextStrokeColor);
      if (transparent(ink) && !shadow && !stroke) continue;
      // Nested tables/grids belong to their own cells, not the containing cell.
      if (parent.closest('th, td, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]') !== cell) continue;
      // Whitespace can advance a Range without painting a glyph (notably under white-space: pre).
      for (const match of text.data.matchAll(/\S+/g)) {
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
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
