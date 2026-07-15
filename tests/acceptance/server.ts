/**
 * Acceptance-local loopback server for compiled-CLI acceptance tests.
 *
 * Serves the custom fixture pages that the shared fixture server
 * (tests/fixtures/app/server.ts) does not provide: a clean single-line-tab
 * page, a mutable "settings" page whose wrap state the test toggles for the
 * agent fix-and-rerun scenario, and a cookie-gated secure page for the
 * authentication scenario.
 *
 * Everything is inline HTML served on 127.0.0.1 with no external resources so
 * checks settle instantly and deterministically.
 */

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

const CLEAN_TABS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>clean tabs</title></head>
<body>
<div role="tablist">
<button role="tab" aria-selected="true" data-testid="overview" style="white-space:nowrap">Overview</button>
<button role="tab" aria-selected="false" data-testid="details" style="white-space:nowrap">Details</button>
</div>
</body>
</html>`;

const WRAPPED_SETTINGS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>settings wrapped</title></head>
<body>
<div role="tablist">
<button role="tab" data-testid="settings" style="display:inline-block;max-width:76px;white-space:normal">Account Settings</button>
</div>
</body>
</html>`;

const FIXED_SETTINGS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>settings fixed</title></head>
<body>
<div role="tablist">
<button role="tab" data-testid="settings" style="white-space:nowrap">Account Settings</button>
</div>
</body>
</html>`;

/**
 * Mobile-only regression fixture: a single tab whose label is wide enough to
 * wrap on a 402px iPhone viewport but fit on one line at the 1470px MacBook
 * viewport. The button is reset to border-box with no padding/border so its
 * content width equals the viewport width deterministically.
 */
const MOBILE_ONLY_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mobile-only layout</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; }
  [role="tab"] { display: block; width: 100%; white-space: normal; box-sizing: border-box; padding: 0; border: 0; }
</style>
</head>
<body>
<div role="tablist">
<button role="tab" data-testid="responsive" aria-selected="true">Account Notification Preferences and Privacy Configuration Settings Dashboard Panel</button>
</div>
</body>
</html>`;

export interface AcceptanceServer {
  readonly url: string;
  readonly port: number;
  /** Toggles the /settings page between wrapped (violation) and fixed (clean). */
  setSettingsWrapped(wrapped: boolean): void;
  close(): Promise<void>;
}

export function startAcceptanceServer(): AcceptanceServer {
  let settingsWrapped = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/clean") {
        return new Response(CLEAN_TABS_HTML, { headers: HTML_HEADERS });
      }

      if (pathname === "/mobile-only") {
        return new Response(MOBILE_ONLY_HTML, { headers: HTML_HEADERS });
      }

      if (pathname === "/settings") {
        const html = settingsWrapped ? WRAPPED_SETTINGS_HTML : FIXED_SETTINGS_HTML;
        return new Response(html, { headers: HTML_HEADERS });
      }

      // Cookie-gated secure page: returns 403 without the session cookie,
      // clean single-line tabs when authenticated.
      if (pathname === "/secure") {
        const cookie = request.headers.get("cookie") ?? "";
        if (!cookie.includes("session=authenticated")) {
          return new Response("forbidden", { status: 403 });
        }
        return new Response(CLEAN_TABS_HTML, { headers: HTML_HEADERS });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("acceptance server did not bind a port");
  return {
    url: `http://${server.hostname}:${port}`,
    port,
    setSettingsWrapped: (wrapped) => {
      settingsWrapped = wrapped;
    },
    close: () => server.stop(true),
  };
}
