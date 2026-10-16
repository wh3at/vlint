import { chromium, firefox, webkit, devices } from "playwright";

for (const [engine, browserType, preset] of [["chromium", chromium, "Desktop Chrome"], ["firefox", firefox, "Desktop Firefox"], ["webkit", webkit, "Desktop Safari"]]) {
  const browser = await browserType.launch({ headless: true });
  try {
    const options = { viewport: { width: 400, height: 500 }, screen: { width: 700, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices[preset].userAgent, locale: "en-US", timezoneId: "UTC" };
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.setContent('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>fixture</body></html>');
    const observed = await page.evaluate(() => ({ ua: navigator.userAgent, width: innerWidth, height: innerHeight, screen: screen.width, screenHeight: screen.height, dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0 }));
    console.log(JSON.stringify({ engine, version: browser.version(), options, observed }));
    await context.close();
  } finally { await browser.close(); }
}
