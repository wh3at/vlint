# Browser management validation (#56)

The primary seam is the compiled `dist/vlint-linux-x64` executable, not a source-level Playwright substitute.

## Reproduce

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check:architecture
bun run test:unit
bun run build:linux-x64
bun test tests/acceptance/browser-management.test.ts tests/integration/browser-install.test.ts
VLINT_BROWSER_CONTAINER_ACCEPTANCE=1 bun test tests/acceptance/browser-management-container.test.ts
```

The container test uses the repository's existing Ubuntu 24.04 Docker validation approach. It bootstraps only transport certificates, then invokes the compiled `browser install` command for all browser and host dependency preparation. There is no test-owned browser dependency package list. Each run owns a uniquely named container, its private `/tmp/browsers-56` cache, and cleanup in `finally`. `PLAYWRIGHT_SKIP_BROWSER_GC=1` prevents garbage collection of unrelated assets. The test disconnects Docker networking before readiness probes, then removes execute permission from Firefox to prove file presence is insufficient. It prints the complete readiness evidence before removing its own container. It does not prune images or other containers.

## Observed acceptance

A real run passed initial preparation, repeated preparation, forced repair, offline readiness, and executable-present Firefox launch failure (37 assertions). All three engines passed dependency validation, launch, empty-page creation/close, and browser close:

| Engine | Expected / obtained version | Revision | Version source | Selected executable |
| --- | --- | --- | --- | --- |
| Chromium | 149.0.7827.55 | 1228 | browser.version | chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell |
| Firefox | 151.0 | 1532 | browser.version | firefox-1532/firefox/firefox |
| WebKit | 26.5 | 2311 | playwright-metadata | webkit-2311/pw_run.sh |

After Firefox lost execute permission, status exited 2, Firefox remained executable-present but launch-failed with `EACCES`, obtained version was null, and Chromium/WebKit remained ready. No project configuration was supplied. An independent compiled empty-cache test also exited 2, reported all three engines unavailable, and left the cache empty with downloads pointed at an unreachable loopback address.

TDD evidence: the compiled empty-cache three-engine status test failed on the baseline, then passed after implementation. A two-component `Firefox 151.0` version probe test failed before the version parser update, then passed; an obtained mismatching version remains rejected. Obsolete Chromium-only mocked readiness and separate dependency-mode tests were replaced by compiled process evidence and current command grammar tests.

## Host limitation and isolation ownership

On the execution host, standard Playwright preparation selected the Ubuntu 24.04 fallback and reported missing libraries. The standard `playwright install --with-deps chromium firefox webkit` attempt failed because sudo required a password/terminal. No host packages, library patches, privilege bypasses, or custom browser package lists were used. The parent approved the existing isolated Docker approach for real acceptance instead. This does not establish support for every Linux distribution.

The exploratory `vlint-56-acceptance` container was removed after successful preparation. Automated acceptance containers remove themselves. The pulled `ubuntu:24.04` image is intentionally retained for downstream validation reuse; no dedicated image was built and no global cleanup was run. Worker worktree and ignored compiled artifacts are preserved for integration review. Later environment-execution and installer tickets retain ownership of their contracts; this ticket does not claim those full-spec behaviors are complete.
