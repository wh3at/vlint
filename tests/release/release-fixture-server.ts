// Release-validation fixture server (U6).
//
// Serves a minimal page whose only tab renders on a single visual line, so the
// production `vlint check --url` happy path returns a clean run (exit 0). This
// is a test-only artifact: it is compiled in the release build job, mounted
// read-only into the clean validation guest, and is NOT included in the
// shipped archive. It exists separately from tests/release/fixture-server.ts
// (the U1 feasibility fixture) so neither fixture constrains the other.
//
// Usage: vlint-release-fixture-server [port]   -> prints "http://127.0.0.1:<port>"

// Module scope: isolates top-level declarations from other test scripts.
export {};
const requestedPort = Number.parseInt(process.argv[2] ?? "0", 10);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("Port must be an integer from 0 through 65535");
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 16px/1.4 sans-serif; }
  [role="tab"] { white-space: nowrap; }
</style></head>
<body>
  <div role="tablist">
    <button role="tab" id="settings" aria-selected="true">Settings</button>
  </div>
</body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: requestedPort,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

process.stdout.write(`http://${server.hostname}:${server.port}\n`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void server.stop(true).finally(() => process.exit(0));
  });
}
