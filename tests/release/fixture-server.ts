const requestedPort = Number.parseInt(process.argv[2] ?? "0", 10);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("Port must be an integer from 0 through 65535");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: requestedPort,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return new Response("ok");
    return new Response(
      "<!doctype html><html><body><main id=\"probe\">compiled-playwright-ok</main></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
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
