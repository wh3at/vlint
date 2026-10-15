import type { Page } from "playwright";
import type { EffectiveSvgTextClippingRule } from "../contracts/config";
import type { ClippingDirection, Geometry, RuleEvaluationOutcome, SvgTextClippingViolation } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";
import { chooseUniqueLocator, composeLocators, cssEscape, LOCATOR_SEMANTIC_ATTRIBUTES, LOCATOR_STABLE_DATA_ATTRIBUTES } from "./locator";

function extractSvgText({ excludeSelectors, tolerancePx }: {
  excludeSelectors: readonly string[];
  tolerancePx: number;
}, locate: (element: Element) => string): RuleEvaluationOutcome<SvgTextClippingViolation> {
  const violations: SvgTextClippingViolation[] = [];
  let elementsInspected = 0;
  const failure = (code: Failure["code"], message: string): RuleEvaluationOutcome<SvgTextClippingViolation> => ({
    facts: { elementsInspected, violations: [] },
    failure: { stage: "rule-evaluation", code, message, target: null, device: null, rule: null },
  });
  for (const selector of excludeSelectors) {
    try { document.querySelectorAll(selector); }
    catch { return failure("exclude-selector-invalid", `Invalid exclude selector "${selector}".`); }
  }
  const axisAligned = (matrix: DOMMatrixReadOnly) => matrix.is2D !== false && matrix.a > 0 && matrix.d > 0 && Math.abs(matrix.b) < 1e-8 && Math.abs(matrix.c) < 1e-8;
  const clips = new Set(["hidden", "clip"]);
  const containers = new Set(["block", "flow-root", "list-item", "inline-block", "table", "inline-table", "table-cell", "table-caption", "flex", "inline-flex", "grid", "inline-grid"]);
  let context: CanvasRenderingContext2D | null = null;
  try {
    for (const element of document.querySelectorAll("svg text")) {
      if (!(element instanceof SVGTextElement) || excludeSelectors.some((selector) => element.closest(selector))) continue;
      if (element.closest("defs, symbol, clipPath, mask, pattern, marker, foreignObject")) continue;
      const style = getComputedStyle(element);
      if (style.visibility !== "visible" || style.fill === "none" || /rgba\([^)]*,\s*0\)$/.test(style.fill) || Number(style.fillOpacity) === 0) continue;
      if (element.children.length > 0 || !element.textContent?.trim()) continue;
      const text = element.textContent.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");
      if (/[\u0590-\u08ff\ufb1d-\ufeff\u202a-\u202e\u2066-\u2069]/u.test(text)) continue;
      if (style.whiteSpace !== "nowrap" && style.whiteSpace !== "normal") continue;
      if (style.direction !== "ltr" || style.unicodeBidi !== "normal" || style.writingMode !== "horizontal-tb" ||
          style.fontStretch !== "100%" || style.fontSizeAdjust !== "none" ||
          !["auto", "alphabetic"].includes(style.dominantBaseline) ||
          !["auto", "baseline"].includes(style.alignmentBaseline) ||
          !["baseline", "0px"].includes(style.baselineShift) || style.stroke !== "none" || style.webkitTextStrokeWidth !== "0px" ||
          !["normal", "0px"].includes(style.letterSpacing) || !["normal", "0px"].includes(style.wordSpacing) ||
          style.textTransform !== "none" || style.textShadow !== "none" || style.textDecorationLine !== "none" ||
          style.fontVariantCaps !== "normal" || style.fontFeatureSettings !== "normal" || style.fontVariationSettings !== "normal") continue;
      if (element.x.baseVal.numberOfItems > 1 || element.y.baseVal.numberOfItems > 1 ||
          element.hasAttribute("dx") || element.hasAttribute("dy") || element.hasAttribute("rotate") || element.hasAttribute("textLength")) continue;
      const ancestors: { element: Element; style: CSSStyleDeclaration }[] = [];
      let supported = true;
      for (let current: Element | null = element; current; current = current.parentElement) {
        const css = getComputedStyle(current);
        ancestors.push({ element: current, style: css });
        if (current instanceof SVGSVGElement && (current.width.baseVal.value <= 0 || current.height.baseVal.value <= 0)) supported = false;
        if (current instanceof SVGSVGElement && current.ownerSVGElement !== null) {
          if (css.transform !== "none" || css.translate !== "none" || css.scale !== "none" ||
              (["x", "y", "width", "height"] as const).some((name) => {
                const value = css.getPropertyValue(name);
                return value !== "auto" && Number.parseFloat(value) !== current[name].baseVal.value;
              })) supported = false;
        }
        if ((current instanceof HTMLElement || current instanceof SVGSVGElement) && ["absolute", "fixed", "sticky"].includes(css.position)) supported = false;
        if (css.direction !== "ltr" && [css.overflowX, css.overflowY].some((value) => ["auto", "scroll"].includes(value))) supported = false;
        if (css.display === "none" || css.contentVisibility !== "visible" || Number(css.opacity) === 0 ||
            css.clipPath !== "none" || css.maskImage !== "none" || css.filter !== "none" ||
            css.clip !== "auto" || /paint|strict|content/.test(css.contain) ||
            css.rotate !== "none" || css.perspective !== "none" || css.translate.split(/\s+/).length > 2 || css.scale.split(/\s+/).length > 2 ||
            (css.transform !== "none" && !axisAligned(new DOMMatrixReadOnly(css.transform))) ||
            (css.scale !== "none" && css.scale.split(/\s+/).some((value) => Number(value) <= 0)) ||
            (current instanceof SVGTextContentElement && current !== element)) supported = false;
        const rectangularClip = [css.overflowX, css.overflowY].some((value) => ["hidden", "clip", "auto", "scroll"].includes(value));
        if (rectangularClip && ([css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius].some((radius) => /[1-9]/.test(radius)) ||
            !(current instanceof SVGSVGElement ? ["0px", "content-box"] : ["0px"]).includes(css.overflowClipMargin))) supported = false;
      }
      if (!supported) continue;
      const matrix = element.getScreenCTM();
      if (matrix === null) return failure("geometry-evaluation-failed", "SVG text has no screen transform.");
      if (!axisAligned(matrix)) continue;
      context ??= document.createElement("canvas").getContext("2d");
      if (context === null) return failure("geometry-evaluation-failed", "Canvas text measurement is unavailable.");
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      context.direction = "ltr";
      context.fontKerning = style.fontKerning as CanvasFontKerning;
      context.fontStretch = "normal";
      const metrics = context.measureText(text);
      const values = [metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent, metrics.width];
      if (!values.every(Number.isFinite)) return failure("geometry-evaluation-failed", "Canvas returned invalid SVG text metrics.");
      const advance = element.getComputedTextLength();
      if (!Number.isFinite(advance)) return failure("geometry-evaluation-failed", "SVG text returned an invalid advance.");
      if (Math.abs(advance - metrics.width) > 0.1) continue;
      const origin = element.getStartPositionOfChar(0);
      const geometry: Geometry = {
        x: matrix.a * (origin.x - metrics.actualBoundingBoxLeft) + matrix.e,
        y: matrix.d * (origin.y - metrics.actualBoundingBoxAscent) + matrix.f,
        width: matrix.a * (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight),
        height: matrix.d * (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent),
      };
      if (![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) || geometry.width < 0 || geometry.height < 0) {
        return failure("geometry-evaluation-failed", "SVG text has invalid ink geometry.");
      }
      if (geometry.width === 0 || geometry.height === 0) continue;
      elementsInspected += 1;
      const reachable = { left: geometry.x, right: geometry.x + geometry.width, top: geometry.y, bottom: geometry.y + geometry.height };
      for (const ancestor of ancestors.slice(1)) {
        const current = ancestor.element;
        const css = ancestor.style;
        const layout = current as HTMLElement;
        const scrollX = current instanceof HTMLElement && containers.has(css.display) && ["auto", "scroll"].includes(css.overflowX);
        const scrollY = current instanceof HTMLElement && containers.has(css.display) && ["auto", "scroll"].includes(css.overflowY);
        const clipX = clips.has(css.overflowX);
        const clipY = clips.has(css.overflowY);
        if (!clipX && !clipY && !scrollX && !scrollY) continue;
        let boundary: Geometry;
        if (current instanceof SVGSVGElement && current.ownerSVGElement !== null) {
          const parentMatrix = (current.parentElement as unknown as SVGGraphicsElement).getScreenCTM();
          if (parentMatrix === null) return failure("geometry-evaluation-failed", "SVG viewport has no screen transform.");
          if (!axisAligned(parentMatrix)) continue;
          boundary = { x: parentMatrix.a * current.x.baseVal.value + parentMatrix.e,
            y: parentMatrix.d * current.y.baseVal.value + parentMatrix.f,
            width: parentMatrix.a * current.width.baseVal.value, height: parentMatrix.d * current.height.baseVal.value };
        } else {
          if (!(current instanceof SVGSVGElement) && !containers.has(css.display)) continue;
          const rect = current.getBoundingClientRect();
          const number = (value: string) => Number.parseFloat(value) || 0;
          const borders = { left: number(css.borderLeftWidth), right: number(css.borderRightWidth), top: number(css.borderTopWidth), bottom: number(css.borderBottomWidth) };
          const paddingX = number(css.paddingLeft) + number(css.paddingRight);
          const paddingY = number(css.paddingTop) + number(css.paddingBottom);
          const width = number(css.width) + (css.boxSizing === "border-box" ? 0 : borders.left + borders.right + paddingX);
          const height = number(css.height) + (css.boxSizing === "border-box" ? 0 : borders.top + borders.bottom + paddingY);
          const scaleX = width > 0 ? rect.width / width : 1;
          const scaleY = height > 0 ? rect.height / height : 1;
          const svgPaddingX = current instanceof SVGSVGElement ? number(css.paddingLeft) : 0;
          const svgPaddingY = current instanceof SVGSVGElement ? number(css.paddingTop) : 0;
          boundary = { x: rect.left + (borders.left + svgPaddingX) * scaleX,
            y: rect.top + (borders.top + svgPaddingY) * scaleY,
            width: current instanceof SVGSVGElement ? rect.width - (borders.left + borders.right + paddingX) * scaleX : layout.clientWidth * scaleX,
            height: current instanceof SVGSVGElement ? rect.height - (borders.top + borders.bottom + paddingY) * scaleY : layout.clientHeight * scaleY };
        }
        if (scrollX || scrollY) {
          const rect = current.getBoundingClientRect();
          const scaleX = layout.offsetWidth > 0 ? rect.width / layout.offsetWidth : 1;
          const scaleY = layout.offsetHeight > 0 ? rect.height / layout.offsetHeight : 1;
          if (scrollX) {
            reachable.left = Math.min(reachable.left + layout.scrollLeft * scaleX, boundary.x + boundary.width);
            reachable.right = Math.max(reachable.right + (layout.scrollLeft - layout.scrollWidth + layout.clientWidth) * scaleX, boundary.x);
          }
          if (scrollY) {
            reachable.top = Math.min(reachable.top + layout.scrollTop * scaleY, boundary.y + boundary.height);
            reachable.bottom = Math.max(reachable.bottom + (layout.scrollTop - layout.scrollHeight + layout.clientHeight) * scaleY, boundary.y);
          }
        }
        const overflowPx = {
          left: clipX ? Math.max(0, boundary.x - reachable.left) : 0,
          right: clipX ? Math.max(0, reachable.right - boundary.x - boundary.width) : 0,
          top: clipY ? Math.max(0, boundary.y - reachable.top) : 0,
          bottom: clipY ? Math.max(0, reachable.bottom - boundary.y - boundary.height) : 0,
        };
        const directions = (Object.keys(overflowPx) as ClippingDirection[]).filter((side) => overflowPx[side] > tolerancePx);
        if (directions.length === 0) continue;
        violations.push({ type: "svg-text-clipping", locator: locate(element), text: element.textContent!, geometry,
          clipLocator: locate(current), clipGeometry: boundary, directions, overflowPx, tolerancePx });
      }
    }
    return { facts: { elementsInspected, violations }, failure: null };
  } catch {
    return failure("geometry-evaluation-failed", "SVG text geometry could not be measured.");
  }
}

function browserLocator(element: Element, choose: typeof chooseUniqueLocator, stable: readonly string[], semantic: readonly string[]): string {
  const attribute = (names: readonly string[]) => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value !== null) return { name, value };
    }
    return null;
  };
  const path: { tag: string; index: number }[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    let index = 1;
    for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === current.localName && sibling.namespaceURI === current.namespaceURI) index += 1;
    }
    path.unshift({ tag: current.localName, index });
  }
  const locator = choose({ tag: element.localName, id: element.id || null, path,
    stableDataAttribute: attribute(stable), semanticAttribute: attribute(semantic) },
    (selector) => document.querySelectorAll(selector).length);
  if (locator === null || document.querySelector(locator) !== element) throw new Error("SVG locator is not unique.");
  return locator;
}

export async function evaluateSvgTextClipping(page: Page, rule: EffectiveSvgTextClippingRule, target: string | null = null): Promise<RuleEvaluationOutcome<SvgTextClippingViolation>> {
  try {
    const locatorSource = `(element) => { const cssEscape = ${cssEscape.toString()}; const composeLocators = ${composeLocators.toString()}; return (${browserLocator.toString()})(element, (${chooseUniqueLocator.toString()}), ${JSON.stringify(LOCATOR_STABLE_DATA_ATTRIBUTES)}, ${JSON.stringify(LOCATOR_SEMANTIC_ATTRIBUTES)}); }`;
    const args = { excludeSelectors: rule.excludeSelectors, tolerancePx: rule.tolerancePx };
    const result = await page.evaluate<RuleEvaluationOutcome<SvgTextClippingViolation>>(`(${extractSvgText.toString()})(${JSON.stringify(args)}, ${locatorSource})`);
    return { ...result, failure: result.failure === null ? null : { ...result.failure, rule: rule.name, target } };
  } catch {
    return { facts: { elementsInspected: 0, violations: [] }, failure: {
      stage: "rule-evaluation", code: "rule-script-failed", message: "SVG text measurement could not read the page.", target, device: null, rule: rule.name,
    } };
  }
}
