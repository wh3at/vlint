import type { Frame, Page, Request } from "playwright";
import type { EffectiveAuditCase, ReadyState } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";

export function sameUrl(left: string, right: string): boolean {
  return new URL(left).href === new URL(right).href;
}

export function observeMainFrameNavigation(
  page: Page,
  fixedUrl: string,
  onNavigation: (url: string) => void,
): { stop(): void; hasDocumentNavigation(): boolean } {
  let documentNavigation = false;
  const onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigation = true;
  };
  const onFrameNavigated = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (documentNavigation || !sameUrl(url, fixedUrl)) onNavigation(url);
  };
  page.on("request", onRequest);
  page.on("framenavigated", onFrameNavigated);
  return {
    hasDocumentNavigation: () => documentNavigation,
    stop: () => {
      page.off("request", onRequest);
      page.off("framenavigated", onFrameNavigated);
    },
  };
}

export function allowedArrival(auditCase: Pick<EffectiveAuditCase, "url" | "allowedUrls">, url: string): boolean {
  return [auditCase.url, ...(auditCase.allowedUrls ?? [])].some((allowed) => sameUrl(allowed, url));
}

async function readySatisfied(page: Page, selector: string, state: ReadyState): Promise<boolean> {
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

async function checkBoundary(page: Page, auditCase: EffectiveAuditCase, fixedUrl: string): Promise<Failure | null> {
  let code: "url-mismatch" | "ready-lost" | "navigation-during-measurement" | null = null;
  let actualUrl = page.url();
  try {
    const snapshot = await page.evaluate(() => ({ url: location.href, fonts: document.fonts.status }));
    actualUrl = snapshot.url;
    if (!sameUrl(actualUrl, fixedUrl)) code = "url-mismatch";
    else if (snapshot.fonts !== "loaded" || (auditCase.readyCondition !== null &&
      !await readySatisfied(page, auditCase.readyCondition.selector, auditCase.readyCondition.state))) code = "ready-lost";
  } catch {
    actualUrl = page.url();
    code = !sameUrl(actualUrl, fixedUrl) ? "url-mismatch" : auditCase.readyCondition === null ? "navigation-during-measurement" : "ready-lost";
  }
  if (code === null) return null;
  return {
    stage: code === "ready-lost" ? "ready-condition" : "navigation",
    code,
    message: code === "ready-lost" ? "ready state was not satisfied or could not be verified at a measurement boundary" : "target URL was not satisfied or could not be verified at a measurement boundary",
    target: auditCase.name,
    device: auditCase.deviceName,
    rule: null,
    actualUrl,
  };
}

export async function measureRule(
  page: Page,
  auditCase: EffectiveAuditCase,
  fixedUrl: string,
  evaluate: (page: Page) => Promise<RuleEvaluationOutcome>,
): Promise<RuleEvaluationOutcome> {
  const startFailure = await checkBoundary(page, auditCase, fixedUrl);
  if (startFailure !== null) return { facts: { elementsInspected: 0, violations: [] }, failure: startFailure };
  let outcome: RuleEvaluationOutcome;
  try {
    outcome = await evaluate(page);
  } catch (error) {
    const failure = await checkBoundary(page, auditCase, fixedUrl);
    if (failure !== null) return { facts: { elementsInspected: 0, violations: [] }, failure };
    throw error;
  }
  const failure = await checkBoundary(page, auditCase, fixedUrl);
  return failure === null ? outcome : { facts: { elementsInspected: 0, violations: [] }, failure };
}
