import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const PAGES_DIR = join(ROOT, "pages");
const FONT_PATH = join(ROOT, "fonts", "test-regular.ttf");

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

export interface FixtureServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function staticPage(name: string): Response | null {
  // Only bare filenames directly under pages/ are served; no traversal.
  if (name.length === 0 || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return null;
  }
  const filePath = join(PAGES_DIR, name);
  if (!existsSync(filePath)) return null;
  return new Response(Bun.file(filePath), { headers: HTML_HEADERS });
}

/**
 * Local, deterministic fixture application served on loopback for the browser
 * integration tests. Owned by U3. Serves static pages plus a few status /
 * timing / auth routes the tests rely on.
 */
export function startFixtureServer(options: { readonly port?: number } = {}): FixtureServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);

      if (pathname === "/health") return new Response("ok");

      if (pathname === "/status") {
        const code = Number.parseInt(searchParams.get("code") ?? "0", 10);
        return new Response(`status ${code}`, { status: Number.isInteger(code) ? code : 500 });
      }

      if (pathname === "/hang") {
        const { promise } = Promise.withResolvers<void>();
        return new Response(await promise.then(() => undefined));
      }

      if (pathname === "/slow") {
        const ms = Number.parseInt(searchParams.get("delay") ?? "0", 10);
        if (Number.isFinite(ms) && ms > 0) await delay(ms);
        return new Response(
          `<!doctype html><html><body><main id="loaded">slow</main></body></html>`,
          { headers: HTML_HEADERS },
        );
      }

      if (pathname === "/auth-gated") {
        const cookie = request.headers.get("cookie") ?? "";
        const authenticated = cookie.includes("session=authenticated");
        const body = authenticated
          ? `<!doctype html><html><body><main id="principal">AUTHENTICATED</main></body></html>`
          : `<!doctype html><html><body><main id="principal">ANONYMOUS</main></body></html>`;
        return new Response(body, { headers: HTML_HEADERS });
      }

      if (pathname === "/font.ttf") {
        const ms = Number.parseInt(searchParams.get("delay") ?? "0", 10);
        if (Number.isFinite(ms) && ms > 0) await delay(ms);
        return new Response(Bun.file(FONT_PATH), { headers: { "content-type": "font/ttf" } });
      }

      if (pathname === "/") {
        const index = staticPage("index.html");
        if (index !== null) return index;
      }

      const page = staticPage(pathname.slice(1));
      if (page !== null) return page;

      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("fixture server did not bind a port");
  return {
    url: `http://${server.hostname}:${port}`,
    port,
    close: () => server.stop(true),
  };
}

// Standalone mode for compiled-binary acceptance scenarios.
const requestedPort = Number.parseInt(process.argv[2] ?? "0", 10);
const isMain = import.meta.path === process.argv[1];
if (isMain) {
  const server = startFixtureServer({ port: requestedPort });
  process.stdout.write(`${server.url}\n`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void server.close().finally(() => process.exit(0));
    });
  }
}
