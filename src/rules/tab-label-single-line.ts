/// <reference lib="dom" />
/**
 * tab-label-single-line rule evaluator (U4, KTD8).
 *
 * Owns only its boundary: it inspects a ready `Page`, returns observed
 * `RuleEvaluationFact`s plus an optional typed `Failure`, and never assigns run
 * dispositions or the global zero-label verdict (those are U5's job).
 *
 * Measurement runs in two browser round-trips: one extraction pass that pulls
 * raw, deterministic per-candidate data (rendered-state flags, generated-content
 * flags, text-fragment rects with resolved line-height, the locator descriptor,
 * normalized innerText, and the label bounding box), and — only when there are
 * violations — one verification pass that authoritatively confirms each composed
 * locator resolves to exactly one element via `document.querySelectorAll`. The
 * pure algorithms (line clustering, locator composition) live in Node so they
 * are unit-testable; the browser only extracts data and counts.
 */

import type { Page } from "playwright";
import type { EffectiveTabLabelSingleLineRule } from "../contracts/config";
import type {
  Geometry,
  RuleEvaluationFact,
  RuleEvaluationOutcome,
  TabLabelSingleLineViolation,
} from "../contracts/evaluation";
import type { Failure, FailureCode } from "../contracts/failure";
import {
  LOCATOR_SEMANTIC_ATTRIBUTES,
  LOCATOR_STABLE_DATA_ATTRIBUTES,
  composeLocators,
  type ElementDescriptor,
} from "./locator";

/** A measured text fragment: one non-zero-area Range rect + resolved line-height. */
export interface TextFragment {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
}

/** Configuration handed to the in-page extractor (must serialize cleanly). */
interface InPageConfig {
  readonly additionalCandidateSelectors: readonly string[];
  readonly excludeSelectors: readonly string[];
  readonly labelSelector: string | null;
  readonly stableDataAttrs: readonly string[];
  readonly semanticAttrs: readonly string[];
}

interface InPageFragment {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly lineHeight: number;
}

interface InPageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface InPageCandidate {
  readonly index: number;
  readonly excluded: boolean;
  readonly labelCardinality: boolean;
  readonly labelNotRendered: boolean;
  readonly generatedUnsupported: boolean;
  readonly rendered: boolean;
  readonly fragments: readonly InPageFragment[];
  readonly innerText: string;
  readonly rect: InPageRect | null;
  readonly descriptor: ElementDescriptor | null;
}

interface InPageSelectorError {
  readonly kind: "candidate" | "exclude" | "label";
  readonly selector: string;
  readonly message: string;
}

interface InPageResult {
  readonly selectorError: InPageSelectorError | null;
  readonly candidates: readonly InPageCandidate[];
  readonly measurementError: { readonly index: number; readonly message: string } | null;
}

/** A pending violation awaiting authoritative locator verification. */
interface PendingViolation {
  readonly descriptor: ElementDescriptor;
  readonly geometry: Geometry;
  readonly text: string;
  readonly lineCount: number;
}

// ---------------------------------------------------------------------------
// Pure geometry: non-transitive line clustering (KTD8).
// ---------------------------------------------------------------------------

function fragmentCenter(frag: TextFragment): number {
  return frag.y + frag.height / 2;
}

/**
 * Two fragments are same-line when their rects vertically overlap OR their
 * centers are within half the smaller resolved line-height (KTD8).
 */
function sameLine(a: TextFragment, b: TextFragment): boolean {
  const rectsOverlap = !(a.y + a.height <= b.y || b.y + b.height <= a.y);
  if (rectsOverlap) return true;
  const threshold = 0.5 * Math.min(a.lineHeight, b.lineHeight);
  return Math.abs(fragmentCenter(a) - fragmentCenter(b)) <= threshold;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

interface Cluster {
  readonly order: number;
  readonly members: TextFragment[];
  readonly centers: number[];
  medianCenter: number;
  anchor: TextFragment;
}

/**
 * Pick the cluster anchor: the member whose center is nearest the median center,
 * tie-broken toward the *shorter* fragment so a tall badge can never become the
 * representative that a second line reaches through. This is what makes the
 * clustering non-transitive: a tall element may join a line, but it cannot shift
 * that line's anchor far enough to merge a second line. Full ties keep the
 * earliest member, so the anchor is stable across equal-height fragments.
 */
function chooseAnchor(members: readonly TextFragment[], medianCenter: number): TextFragment {
  let best = members[0]!;
  for (let i = 1; i < members.length; i += 1) {
    const candidate = members[i]!;
    const candidateDist = Math.abs(fragmentCenter(candidate) - medianCenter);
    const bestDist = Math.abs(fragmentCenter(best) - medianCenter);
    const nearer = candidateDist < bestDist;
    const sameDistShorter = candidateDist === bestDist && candidate.height < best.height;
    if (nearer || sameDistShorter) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Cluster fragments non-transitively (KTD8). Each fragment joins exactly one
 * cluster — the nearest by median center among clusters whose anchor it is
 * same-line with — or seeds a new cluster. Returns clusters in creation order.
 */
export function clusterFragments(
  input: readonly TextFragment[],
): readonly (readonly TextFragment[])[] {
  if (input.length === 0) return [];
  const ordered = input
    .map((frag, originalIndex) => ({ frag, originalIndex }))
    .sort(
      (a, b) =>
        fragmentCenter(a.frag) - fragmentCenter(b.frag) ||
        a.frag.x - b.frag.x ||
        a.originalIndex - b.originalIndex,
    );
  const clusters: Cluster[] = [];
  let nextOrder = 0;
  for (const { frag } of ordered) {
    const center = fragmentCenter(frag);
    let best: Cluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      if (!sameLine(frag, cluster.anchor)) continue;
      const dist = Math.abs(center - cluster.medianCenter);
      if (
        best === null ||
        dist < bestDist ||
        (dist === bestDist && cluster.order < best.order)
      ) {
        best = cluster;
        bestDist = dist;
      }
    }
    if (best === null) {
      clusters.push({
        order: nextOrder,
        members: [frag],
        centers: [center],
        medianCenter: center,
        anchor: frag,
      });
      nextOrder += 1;
    } else {
      best.members.push(frag);
      best.centers.push(center);
      best.medianCenter = median(best.centers);
      best.anchor = chooseAnchor(best.members, best.medianCenter);
    }
  }
  return clusters.map((cluster) => cluster.members);
}

/** Number of rendered text lines = number of non-transitive clusters (KTD8). */
export function clusterLineCount(input: readonly TextFragment[]): number {
  return clusterFragments(input).length;
}

function roundFinite(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------
// In-page extractor. Serialized verbatim into the browser; must be fully
// self-contained (no closure captures, only its `config` argument and the DOM).
// ---------------------------------------------------------------------------

function tabLabelExtractor(config: InPageConfig): InPageResult {
  const result: InPageResult = {
    selectorError: null,
    candidates: [],
    measurementError: null,
  };

  function probeSelector(selector: string, kind: "candidate" | "exclude" | "label"): void {
    try {
      document.querySelectorAll(selector);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw { selectorError: { kind, selector, message } };
    }
  }

  try {
    for (const selector of config.additionalCandidateSelectors) {
      probeSelector(selector, "candidate");
    }
    for (const selector of config.excludeSelectors) {
      probeSelector(selector, "exclude");
    }
    if (config.labelSelector !== null) {
      probeSelector(config.labelSelector, "label");
    }
  } catch (raw) {
    const thrown = raw as { selectorError?: InPageSelectorError };
    if (thrown !== null && typeof thrown === "object" && thrown.selectorError !== undefined) {
      return { ...result, selectorError: thrown.selectorError };
    }
    const message = raw instanceof Error ? raw.message : String(raw);
    return { ...result, measurementError: { index: -1, message: `selector probe: ${message}` } };
  }

  function isRendered(el: Element): boolean {
    if (!el.isConnected) return false;
    let node: Element | null = el;
    while (node !== null) {
      const cs = getComputedStyle(node);
      if (cs.display === "none") return false;
      if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
      if (cs.contentVisibility === "hidden") return false;
      node = node.parentElement;
    }
    let opacity = 1;
    node = el;
    while (node !== null) {
      opacity *= parseFloat(getComputedStyle(node).opacity);
      if (!(opacity > 0)) return false;
      node = node.parentElement;
    }
    return true;
  }

  function isSignificantContent(content: string): boolean {
    if (content.length === 0) return false;
    if (content === "none" || content === "normal") return false;
    if (content === '""' || content === "''") return false;
    return true;
  }

  function pseudoHasSignificantContent(owner: Element, pseudo: "::before" | "::after"): boolean {
    const cs = getComputedStyle(owner, pseudo);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (cs.contentVisibility === "hidden") return false;
    if (!(parseFloat(cs.opacity) > 0)) return false;
    return isSignificantContent(cs.content);
  }

  function hasRenderedGeneratedContent(root: Element): boolean {
    const stack: Element[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (isRendered(node)) {
        if (pseudoHasSignificantContent(node, "::before")) return true;
        if (pseudoHasSignificantContent(node, "::after")) return true;
      }
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return false;
  }

  function resolveLineHeight(el: Element): number | null {
    const value = getComputedStyle(el).lineHeight;
    if (value === "normal") return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function extractFragments(root: Element): InPageFragment[] {
    const fragments: InPageFragment[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const text = textNode.nodeValue ?? "";
      if (text.length === 0) continue;
      const lead = text.length - text.replace(/^\s+/, "").length;
      const trail = text.length - text.replace(/\s+$/, "").length;
      const coreLength = text.length - lead - trail;
      if (coreLength <= 0) continue;
      const parent = textNode.parentElement;
      if (parent === null) continue;
      const lineHeight = resolveLineHeight(parent);
      range.setStart(textNode, lead);
      range.setEnd(textNode, lead + coreLength);
      const rects = range.getClientRects();
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        fragments.push({
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
          lineHeight: lineHeight === null ? rect.height : lineHeight,
        });
      }
    }
    return fragments;
  }

  function describeElement(el: Element): ElementDescriptor {
    const tag = el.tagName.toLowerCase();
    const idAttr = el.getAttribute("id");
    const id = idAttr !== null && idAttr.length > 0 ? idAttr : null;
    let stableDataAttribute: { name: string; value: string } | null = null;
    for (const name of config.stableDataAttrs) {
      const value = el.getAttribute(name);
      if (value !== null) {
        stableDataAttribute = { name, value };
        break;
      }
    }
    let semanticAttribute: { name: string; value: string } | null = null;
    for (const name of config.semanticAttrs) {
      const value = el.getAttribute(name);
      if (value !== null) {
        semanticAttribute = { name, value };
        break;
      }
    }
    const path: { tag: string; index: number }[] = [];
    let node: Element | null = el;
    while (node !== null) {
      const parentEl: Element | null = node.parentElement;
      let index = 1;
      if (parentEl !== null) {
        let sibling = parentEl.firstElementChild;
        while (sibling !== null && sibling !== node) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.nextElementSibling;
        }
      }
      path.push({ tag: node.tagName.toLowerCase(), index });
      if (parentEl === null) break;
      node = parentEl;
    }
    path.reverse();
    return { tag, id, stableDataAttribute, semanticAttribute, path };
  }

  function normalizeText(value: string): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  function extractCandidate(el: Element, index: number): InPageCandidate {
    const excluded = config.excludeSelectors.some((selector) => el.matches(selector));
    const candidate: InPageCandidate = {
      index,
      excluded,
      labelCardinality: false,
      labelNotRendered: false,
      generatedUnsupported: false,
      rendered: false,
      fragments: [],
      innerText: "",
      rect: null,
      descriptor: null,
    };
    if (excluded) return candidate;

    let labelRegion: Element = el;
    if (config.labelSelector !== null) {
      const matches = el.querySelectorAll(config.labelSelector);
      if (matches.length !== 1) {
        return { ...candidate, labelCardinality: true };
      }
      labelRegion = matches[0]!;
    }

    const rendered = isRendered(labelRegion);
    if (!rendered) {
      return config.labelSelector !== null
        ? { ...candidate, labelNotRendered: true }
        : candidate;
    }

    if (hasRenderedGeneratedContent(labelRegion)) {
      return { ...candidate, rendered: true, generatedUnsupported: true };
    }

    const fragments = extractFragments(labelRegion);
    const bounding = labelRegion.getBoundingClientRect();
    return {
      ...candidate,
      rendered: true,
      fragments,
      innerText: normalizeText((labelRegion as HTMLElement).innerText),
      rect: {
        x: bounding.left,
        y: bounding.top,
        w: bounding.width,
        h: bounding.height,
      },
      descriptor: describeElement(labelRegion),
    };
  }

  const seen = new Set<Element>();
  const ordered: Element[] = [];
  const collect = (selector: string): void => {
    let elements: NodeListOf<Element>;
    try {
      elements = document.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const el of elements) {
      if (!seen.has(el)) {
        seen.add(el);
        ordered.push(el);
      }
    }
  };
  collect("[role=tab]");
  for (const selector of config.additionalCandidateSelectors) {
    collect(selector);
  }

  const candidates: InPageCandidate[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const el = ordered[index]!;
    try {
      candidates.push(extractCandidate(el, index));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...result, candidates, measurementError: { index, message } };
    }
  }

  return { ...result, candidates };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function buildFailure(
  code: FailureCode,
  message: string,
  ruleName: string,
  targetName: string | null,
): Failure {
  return { stage: "rule-evaluation", code, message, target: targetName, device: null, rule: ruleName };
}


const SELECTOR_ERROR_CODE: Record<InPageSelectorError["kind"], FailureCode> = {
  candidate: "candidate-selector-invalid",
  exclude: "exclude-selector-invalid",
  label: "label-selector-invalid",
};

/**
 * Evaluate the tab-label-single-line rule against a ready page. Returns observed
 * facts and an optional typed failure; never assigns run dispositions or the
 * global zero-label verdict.
 */
export async function evaluateTabLabelSingleLine(
  page: Page,
  rule: EffectiveTabLabelSingleLineRule,
  targetName: string | null = null,
): Promise<RuleEvaluationOutcome<TabLabelSingleLineViolation>> {
  const config: InPageConfig = {
    additionalCandidateSelectors: rule.additionalCandidateSelectors,
    excludeSelectors: rule.excludeSelectors,
    labelSelector: rule.labelSelector,
    stableDataAttrs: LOCATOR_STABLE_DATA_ATTRIBUTES,
    semanticAttrs: LOCATOR_SEMANTIC_ATTRIBUTES,
  };

  let extracted: InPageResult;
  try {
    extracted = await page.evaluate(tabLabelExtractor, config);
  } catch {
    // Protocol rejection (e.g. closed page): empty facts, no partial state.
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: buildFailure(
        "rule-script-failed",
        "Tab-label measurement could not read the page (protocol rejection).",
        rule.name,
        targetName,
      ),
    };
  }

  if (extracted.selectorError !== null) {
    const error = extracted.selectorError;
    return {
      facts: { elementsInspected: 0, violations: [] },
      failure: buildFailure(
        SELECTOR_ERROR_CODE[error.kind],
        `Invalid ${error.kind} selector "${error.selector}": ${error.message}`,
        rule.name,
        targetName,
      ),
    };
  }

  const violations: TabLabelSingleLineViolation[] = [];
  const pending: PendingViolation[] = [];
  let elementsInspected = 0;

  for (const candidate of extracted.candidates) {
    if (candidate.excluded) continue;
    if (candidate.labelCardinality) {
      return finalize(rule, targetName, elementsInspected, violations, pending, page, {
        code: "label-selector-cardinality",
        message: `Label selector "${rule.labelSelector}" did not resolve to exactly one element for candidate #${candidate.index}.`,
      });
    }
    if (candidate.labelNotRendered) {
      return finalize(rule, targetName, elementsInspected, violations, pending, page, {
        code: "label-selector-not-rendered",
        message: `Label selector "${rule.labelSelector}" resolved to a non-rendered element for candidate #${candidate.index}.`,
      });
    }
    if (candidate.generatedUnsupported) {
      return finalize(rule, targetName, elementsInspected, violations, pending, page, {
        code: "generated-content-unsupported",
        message: `Candidate #${candidate.index} renders ::before/::after generated content, which is not measurable.`,
      });
    }
    if (!candidate.rendered || candidate.descriptor === null) continue;
    const fragments: readonly TextFragment[] = candidate.fragments.map((fragment) => ({
      x: fragment.x,
      y: fragment.y,
      width: fragment.w,
      height: fragment.h,
      lineHeight: fragment.lineHeight,
    }));
    if (fragments.length === 0) continue;
    elementsInspected += 1;
    const lineCount = clusterLineCount(fragments);
    if (lineCount >= 2 && candidate.rect !== null) {
      pending.push({
        descriptor: candidate.descriptor,
        geometry: {
          x: roundFinite(candidate.rect.x),
          y: roundFinite(candidate.rect.y),
          width: roundFinite(candidate.rect.w),
          height: roundFinite(candidate.rect.h),
        },
        text: candidate.innerText,
        lineCount,
      });
    }
  }

  if (extracted.measurementError !== null) {
    return finalize(rule, targetName, elementsInspected, violations, pending, page, {
      code: "rule-script-failed",
      message: `Tab-label measurement failed at candidate #${extracted.measurementError.index}: ${extracted.measurementError.message}`,
    });
  }

  if (elementsInspected < rule.minimumLabels) {
    return finalize(rule, targetName, elementsInspected, violations, pending, page, {
      code: "minimum-labels-unmet",
      message: `Inspected ${elementsInspected} label(s); minimum is ${rule.minimumLabels}.`,
    });
  }

  return finalize(rule, targetName, elementsInspected, violations, pending, page, null);
}

interface PendingFailure {
  readonly code: FailureCode;
  readonly message: string;
}

/**
 * Resolve locators for accumulated violations (one authoritative round-trip),
 * then assemble the final outcome. On protocol rejection during verification,
 * prior facts are preserved and reported as a rule-script failure.
 */
async function finalize(
  rule: EffectiveTabLabelSingleLineRule,
  targetName: string | null,
  elementsInspected: number,
  violations: TabLabelSingleLineViolation[],
  pending: readonly PendingViolation[],
  page: Page,
  failure: PendingFailure | null,
): Promise<RuleEvaluationOutcome<TabLabelSingleLineViolation>> {
  let resolvedViolations = violations;
  if (pending.length > 0) {
    const requests: string[][] = pending.map((entry) => [...composeLocators(entry.descriptor)]);
    let picks: (string | null)[];
    try {
      picks = await page.evaluate(
        (selectorsList: string[][]) =>
          selectorsList.map((selectors) => {
            for (const selector of selectors) {
              try {
                if (document.querySelectorAll(selector).length === 1) return selector;
              } catch {
                continue;
              }
            }
            return null;
          }),
        requests,
      );
    } catch {
      return {
        facts: { elementsInspected: elementsInspected, violations },
        failure: buildFailure(
          "rule-script-failed",
          "Tab-label locator verification could not read the page (protocol rejection).",
          rule.name,
          targetName,
        ),
      };
    }
    resolvedViolations = [
      ...violations,
      ...pending.map((entry, index) => {
        const fallback = composeLocators(entry.descriptor);
        const locator = picks[index] ?? fallback[fallback.length - 1]!;
        const violation: TabLabelSingleLineViolation = {
          type: "tab-label-single-line",
          text: entry.text,
          lineCount: entry.lineCount,
          geometry: entry.geometry,
          locator,
        };
        return violation;
      }),
    ];
  }

  return {
    facts: { elementsInspected: elementsInspected, violations: resolvedViolations },
    failure: failure === null ? null : buildFailure(failure.code, failure.message, rule.name, targetName),
  };
}

