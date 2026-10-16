# Declared environment execution validation (#57)

Primary seam: the compiled `dist/vlint-linux-x64` executable, temporary project configurations and fixed loopback pages. No Playwright substitute is used for execution acceptance. Browser preparation follows [#56 validation](browser-management-validation.md).

## Reproduce in the approved isolation

Run from the ticket worktree. The container and browser cache below belong only to #57; do not prune shared assets. Preserve the container for review or remove only this named container afterwards.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check:architecture
bun run build:linux-x64
bun test tests/acceptance/environments.test.ts
docker run --name vlint-57-validation --network host -d \
  -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-57 \
  -v "$PWD:/lane:ro" ubuntu:24.04 sleep infinity
docker exec vlint-57-validation sh -c 'apt-get update >/tmp/bootstrap.log 2>&1 && apt-get install -y ca-certificates >>/tmp/bootstrap.log 2>&1'
docker exec vlint-57-validation /lane/dist/vlint-linux-x64 browser install
VLINT_ENVIRONMENT_CONTAINER=vlint-57-validation bun test tests/acceptance/environments-container.test.ts
```

The host lacks required browser libraries and cannot run password-requiring sudo. No host package policy was changed. Ubuntu 24.04 Docker isolation was explicitly approved; this does not establish universal Linux support. Container `--network host` lets the compiled CLI reach the test-owned loopback fixtures. Every check subprocess points browser downloads at unreachable `http://127.0.0.1:1`. The host-side empty-cache test additionally verifies check leaves its private browser cache empty and plans only the selected Chromium engine.

The container test checks all six platform/browser pairs, two shared referenced devices in reversed reference order, an unused device, and two targets (24 cases). UA, viewport, screen, DPR and touch observations are collected by the fixed fixture. It removes Firefox executable permission, then checks four failed Firefox cases and twenty completed other cases before restoring permission in `finally`. It does not install or repair the damaged browser. The minimum-count slice uses a UA-dependent fixture to produce one tab in five environments and zero in Firefox: undeclared zero succeeds; a minimum of one fails only Firefox; target/device conflict fails before launch; an explicit combination override resolves the conflict without pooling counts.

## RED / GREEN evidence

- Baseline compiled check accepted omitted environments and proceeded beyond config resolution. The new process test failed because no `config-schema-invalid` failure existed (`/tmp/vlint-57-red1.log`). After mandatory environment schema/load changes it passed.
- The compiled six-environment slice initially exited 2 rather than 0 before environment planning/engine execution existed (`/tmp/vlint-57-red2.log`). After engine pooling and environment UA application it passed with real Chromium, Firefox and WebKit (`/tmp/vlint-57-green2.log`).
- A stricter mobile signal assertion exposed upstream differences, not a vlint override. The retained mobile assertions and independent direct probe below document these differences rather than hiding them. Non-mobile explicit screens are verified in all six environments.
- Config acceptance covers omitted/empty environments, empty references, unknown references, duplicate names, unsupported pair, forbidden device UA, forbidden environment/target overrides, and missing selected engine without cache mutation.

## Public API emulation limits measured independently

The shared non-mobile device requests viewport 800×600, screen 1000×900, DPR 1 and no touch. All six environments observe those dimensions. The mobile device requests viewport 400×500, screen 700×800, DPR 2, `isMobile: true`, `hasTouch: true`. UA, viewport and DPR match in all six environments. Observations for the pinned engines are:

| Engine | Version | Mobile screen observed | `navigator.maxTouchPoints > 0` |
| --- | --- | --- | --- |
| Chromium | 149.0.7827.55 | 700×800 | true |
| Firefox | 151.0 | 400×500 | false |
| WebKit | 26.5 | 700×800 | false |

To distinguish the library behavior from vlint, a standalone script imports the same Playwright 1.61.1 package and calls `browser.newContext` with identical public options, without importing vlint. It reproduces these observations:

```sh
docker exec vlint-57-validation sh -c 'apt-get install -y nodejs >/tmp/nodejs-57.log 2>&1'
docker exec vlint-57-validation node /lane/tests/fixtures/environment-57-public-probe.mjs
```

Node is only a validation tool inside this container. Browser/OS dependencies were prepared by the compiled `browser install`, not a test-owned dependency list. Exact requested options and observations are emitted in `/tmp/vlint-57-public-probe.log`. No page-script/private-protocol spoofing, preset substitution, or device-setting changes compensate for these engine-specific signals. `execution.devices` records supplied public context options, not independently measured signals. This is not a claim that Firefox mobile is generally unsupported.

## Integration-stage limits

The old init builder now honestly returns `Omit<Config, "environments">` and omits device UA. It does not fabricate a default environment. Ticket #58 owns replacing that incomplete builder and the init/setup surface with explicit selections. At this stage `bun run test:unit` has 359 passing tests and four known init/setup failures; the separate CLI integration file has one additional init-generation failure. These are not claimed as passing. The #57-owned config/planner/result/output and result-transition tests pass, as do non-init CLI resolution tests. Full three-engine rule/readiness suites belong to #62–#65 and integrated acceptance #66; this ticket does not claim those downstream contracts complete.
