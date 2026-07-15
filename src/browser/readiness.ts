import type { Page } from "playwright";
import type { ReadyState } from "../contracts/config";
import { boundaryFailure, boundarySuccess, type BoundaryResult, type Failure } from "../contracts/failure";

/**
 * Minimal view of the browser-side font machinery read inside `page.evaluate`.
 *
 * The project intentionally does not load the DOM lib, so the page global is
 * narrowed through these named types (assigned to a named const) rather than
 * asserted inline at a member access.
 */
interface PageFontFace {
  readonly status: string;
}

interface PageFontFaceSet {
  readonly status: string;
  forEach(callback: (face: PageFontFace) => void): void;
}

interface PageGlobal {
  readonly document: { readonly fonts: PageFontFaceSet };
}

/** Monotonic budget shared across the target acquisition stages (KTD7). */
export interface Deadline {
  readonly totalMs: number;
  remainingMs(): number;
  elapsedMs(): number;
}

export function createDeadline(totalMs: number): Deadline {
  const start = Date.now();
  return {
    totalMs,
    remainingMs: () => Math.max(0, totalMs - (Date.now() - start)),
    elapsedMs: () => Date.now() - start,
  };
}

export function interruptFailure(): Failure {
  return {
    stage: "interrupt",
    code: "signal-interrupt",
    message: "operation cancelled",
    target: null,
    device: null,
    rule: null,
  };
}

function readyFailure(code: Failure["code"], message: string): Failure {
  return { stage: "ready-condition", code, message, target: null, device: null, rule: null };
}

function fontFailure(code: Failure["code"], message: string): Failure {
  return { stage: "web-font", code, message, target: null, device: null, rule: null };
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Races a task against an abort signal. Resolves/rejects with the task's
 * outcome; rejects with an `AbortError` the instant the signal fires. Used so a
 * cancellation request during any acquisition wait recovers promptly through the
 * same LIFO cleanup path as a normal failure.
 */
export function raceAbort<T>(signal: AbortSignal | undefined, task: Promise<T>): Promise<T> {
  if (signal === undefined) return task;
  if (signal.aborted) return Promise.reject(abortError());
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = (): void => reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  task.then(
    (value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    },
  );
  return promise;
}

function abortError(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}


export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Waits for the declarative ready selector to reach `state` within the
 * remaining target budget. A timed-out wait is `ready-timeout`; an invalid
 * selector is `ready-invalid-selector`; an abort is an interrupt failure.
 */
export async function waitForReadyCondition(
  page: Page,
  selector: string,
  state: ReadyState,
  deadline: Deadline,
  signal: AbortSignal | undefined = undefined,
): Promise<BoundaryResult<void>> {
  if (signalAborted(signal)) return boundaryFailure(interruptFailure());
  const timeout = deadline.remainingMs();
  try {
    await raceAbort(signal, page.waitForSelector(selector, { state, timeout }));
  } catch (error) {
    if (isAbortError(error)) return boundaryFailure(interruptFailure());
    if (isTimeoutError(error)) {
      return boundaryFailure(readyFailure("ready-timeout", "ready condition was not reached within the target deadline"));
    }
    return boundaryFailure(readyFailure("ready-invalid-selector", "ready selector is invalid"));
  }
  return boundarySuccess(undefined);
}

/**
 * Waits for web fonts to settle within the remaining target budget, then
 * verifies no face errored. A never-settling font set is `font-timeout`; a face
 * that failed to load is `font-load-failed`; an abort is an interrupt failure.
 */
export async function waitForFonts(
  page: Page,
  deadline: Deadline,
  signal: AbortSignal | undefined = undefined,
): Promise<BoundaryResult<void>> {
  if (signalAborted(signal)) return boundaryFailure(interruptFailure());
  const timeout = deadline.remainingMs();
  try {
    await raceAbort(
      signal,
      page.waitForFunction(
        () => {
          const global = globalThis as unknown as PageGlobal;
          return global.document.fonts.status === "loaded";
        },
        undefined,
        { timeout },
      ),
    );
  } catch (error) {
    if (isAbortError(error)) return boundaryFailure(interruptFailure());
    if (isTimeoutError(error)) {
      return boundaryFailure(fontFailure("font-timeout", "web fonts did not settle within the target deadline"));
    }
    return boundaryFailure(fontFailure("font-load-failed", "web font readiness check failed"));
  }

  let errorFaces = 0;
  try {
    errorFaces = await page.evaluate(() => {
      const global = globalThis as unknown as PageGlobal;
      let count = 0;
      global.document.fonts.forEach((face) => {
        if (face.status === "error") count += 1;
      });
      return count;
    });
  } catch {
    return boundaryFailure(fontFailure("font-load-failed", "web font readiness check failed"));
  }
  if (errorFaces > 0) {
    return boundaryFailure(fontFailure("font-load-failed", "one or more web fonts failed to load"));
  }
  return boundarySuccess(undefined);
}
