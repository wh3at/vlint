import { expect, test } from "bun:test";
import { buildStandardConfig } from "../../src/commands/init";

for (const descriptor of [undefined, {}, { viewport: { width: 402, height: 681 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, { viewport: { width: 402, height: 681 }, screen: { width: 402, height: "tall" }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }]) {
  test("init reports unavailable public preset fields without substituting another device", () => {
    const result = buildStandardConfig(["iphone:webkit"], { "iPhone 17": descriptor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("init-device-unavailable");
  });
}
