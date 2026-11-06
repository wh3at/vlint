import { expect, spyOn, test } from "bun:test";
import type { Browser } from "playwright";
import { createBrowserRunScope } from "../../src/browser/lifecycle";

test.each(["timeout", "rejection", "success"])("browser close diagnostics preserve the %s outcome", async (scenario) => {
  const previous = process.env.VLINT_DEBUG_BROWSER_CLOSE;
  process.env.VLINT_DEBUG_BROWSER_CLOSE = "1";
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const browser = {
      version: () => "test",
      isConnected: () => true,
      close: () => scenario === "timeout" ? new Promise<void>(() => {}) : scenario === "rejection" ? Promise.reject(new Error("close rejected")) : Promise.resolve(),
    } as unknown as Browser;
    const scope = await createBrowserRunScope({ engine: "webkit", launch: async () => browser, closeTimeoutMs: 10 });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const result = await scope.value.close();
    expect(result.ok).toBe(scenario === "success");
    if (scenario === "success") {
      expect(log).not.toHaveBeenCalled();
    } else {
      if (!result.ok) expect(result.failure.code).toBe("browser-cleanup-failed");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toBe("[DEBUG-browser-close]");
      const diagnostic = JSON.parse(String(log.mock.calls[0]?.[1]));
      expect(diagnostic.engine).toBe("webkit");
      expect(diagnostic.timeoutMs).toBe(10);
      expect(diagnostic.connected).toBe(true);
      expect(diagnostic.error.name).toBe(scenario === "timeout" ? "TimeoutError" : "Error");
    }
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.VLINT_DEBUG_BROWSER_CLOSE;
    else process.env.VLINT_DEBUG_BROWSER_CLOSE = previous;
  }
});
