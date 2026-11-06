import type { Frame, Page, Request } from "playwright";
import type { EffectiveAuditCase } from "../contracts/config";
import type { RuleEvaluationOutcome } from "../contracts/evaluation";
import type { Failure } from "../contracts/failure";
import { createDeadline, interruptFailure, isAbortError, isTimeoutError, raceDeadline, waitForFonts } from "./readiness";

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

function checkBoundary(page: Page, auditCase: EffectiveAuditCase, fixedUrl: string): Promise<Failure | null>;
function checkBoundary(page: Page, auditCase: EffectiveAuditCase, fixedUrl: string, retryLoading: true): Promise<Failure | "fonts-loading" | null>;
async function checkBoundary(page: Page, auditCase: EffectiveAuditCase, fixedUrl: string, retryLoading = false): Promise<Failure | "fonts-loading" | null> {
  let code: "url-mismatch" | "ready-lost" | "navigation-during-measurement" | "font-load-failed" | null = null;
  let actualUrl = page.url();
  try {
    const condition = auditCase.readyCondition;
    let ready = true;
    if (condition !== null) {
      const locator = page.locator(condition.selector);
      const matches = condition.state === "attached" ? locator : locator.filter({ visible: true });
      const count = await matches.count();
      ready = condition.state === "hidden" ? count === 0 : count > 0;
    }
    const snapshot = await page.evaluate(() => {
      document.documentElement.getBoundingClientRect();
      let fontFailed = false;
      document.fonts.forEach((face) => {
        if (face.status === "error") fontFailed = true;
      });
      return { url: location.href, fonts: document.fonts.status, fontFailed };
    });
    actualUrl = snapshot.url;
    if (!sameUrl(actualUrl, fixedUrl)) code = "url-mismatch";
    else if (snapshot.fontFailed) code = "font-load-failed";
    else if (!ready) code = "ready-lost";
    else if (snapshot.fonts !== "loaded") {
      if (retryLoading) return "fonts-loading";
      code = "ready-lost";
    }
  } catch {
    actualUrl = page.url();
    code = !sameUrl(actualUrl, fixedUrl) ? "url-mismatch" : auditCase.readyCondition === null ? "navigation-during-measurement" : "ready-lost";
  }
  if (code === null) return null;
  return {
    stage: code === "font-load-failed" ? "web-font" : code === "ready-lost" ? "ready-condition" : "navigation",
    code,
    message: code === "font-load-failed" ? "one or more web fonts failed to load at a measurement boundary" : code === "ready-lost" ? "ready state was not satisfied or could not be verified at a measurement boundary" : "target URL was not satisfied or could not be verified at a measurement boundary",
    target: auditCase.name,
    device: auditCase.deviceName,
    rule: null,
    actualUrl,
  };
}

function failedMeasurement(failure: Failure): RuleEvaluationOutcome {
  return { facts: { elementsInspected: 0, violations: [] }, failure };
}

export async function measureRule(
  page: Page,
  auditCase: EffectiveAuditCase,
  fixedUrl: string,
  evaluate: (page: Page) => Promise<RuleEvaluationOutcome>,
  signal?: AbortSignal,
): Promise<RuleEvaluationOutcome> {
  const deadline = createDeadline(auditCase.timeoutMs);
  while (true) {
    const fonts = await waitForFonts(page, deadline, signal);
    if (!fonts.ok && fonts.failure.code === "signal-interrupt") return failedMeasurement(fonts.failure);
    let boundary: Failure | "fonts-loading" | null;
    try {
      boundary = await raceDeadline(deadline, signal, () => checkBoundary(page, auditCase, fixedUrl, true));
    } catch (error) {
      if (isAbortError(error)) return failedMeasurement(interruptFailure());
      if (isTimeoutError(error)) return failedMeasurement({ stage: "web-font", code: "font-load-timeout", message: "web fonts did not settle within the target deadline", target: auditCase.name, device: auditCase.deviceName, rule: null, actualUrl: page.url() });
      throw error;
    }
    if (boundary !== null && boundary !== "fonts-loading") return failedMeasurement(boundary);
    if (!fonts.ok) return failedMeasurement({ ...fonts.failure, target: auditCase.name, device: auditCase.deviceName, actualUrl: page.url() });
    if (boundary === null) break;
  }
  let outcome: RuleEvaluationOutcome;
  try {
    outcome = await evaluate(page);
  } catch (error) {
    const failure = await checkBoundary(page, auditCase, fixedUrl);
    if (failure !== null) return failedMeasurement(failure);
    throw error;
  }
  const failure = await checkBoundary(page, auditCase, fixedUrl);
  return failure === null ? outcome : failedMeasurement(failure);
}
