# SVG and local rules: three-engine acceptance (#65)

The compiled CLI runs SVG ink measurement and local evaluators in the selected
engine, not in a Chromium substitute. A rule-specific failure leaves completed
SVG/local facts intact and allows later independent rules to run. External local
rules remain responsible for their own browser API requirements; this acceptance
does not certify arbitrary third-party evaluators.

SVG scope restrictions in the README still apply. In particular rotated runs,
definition text and configured exclusions are not inspected. Unsupported CSS
`overflow-clip-margin` now means the engine's ordinary rectangular clip, rather
than excluding every clipped SVG in WebKit. Non-default supported clip margins
remain outside the rule's scope. A missing screen transform or unavailable Canvas
measurement produces `geometry-evaluation-failed`, not a successful zero count.

## Reproduce

Use the approved Ubuntu 24.04 Docker isolation described in
[browser management validation](browser-management-validation.md), with this
worktree mounted read-only at `/lane`, host loopback networking and a private
browser cache. Never prune shared caches. This lane tagged the existing prepared
`vlint-63-validation:local` snapshot as `vlint-65-validation:local`, created its
own container and copied its snapshot's `/tmp/browsers-57` to `/tmp/browsers-65`.
It did not modify another lane's container or browser assets.

```sh
bun install --frozen-lockfile
docker tag vlint-63-validation:local vlint-65-validation:local
docker run -d --name vlint-65-validation --network host \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-65 \
  -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/lane:ro" vlint-65-validation:local sleep infinity
docker exec vlint-65-validation cp -a /tmp/browsers-57 /tmp/browsers-65
bun run build:linux-x64
VLINT_SVG_LOCAL_CONTAINER=vlint-65-validation bun test tests/acceptance/svg-local-65-container.test.ts
bun run typecheck
bun run check:architecture
```

The test launches actual Chromium 149.0.7827.55 (1228), Firefox 151.0 (1532) and
WebKit 26.5 (2311). WebKit's obtained version is Playwright metadata, not an
independent binary probe. Each compiled child has downloads pointed at an
unreachable loopback address. Complete results are read from that child's
`reportPath` inside the container.

Eight fixed pages cover clean ink, right clipping, explicit/structural exclusions,
missing SVG transforms, unavailable Canvas, throwing local evaluators, invalid
local facts and actionable local violations. The two unavailable-API pages
intentionally replace the corresponding DOM API in the fixture; these are fault
injections in real engines, not evidence that the ordinary engines lack those
APIs. Target counts, violation locators, directions and failures are asserted.
A later local evaluator succeeds after every failure. Two runs against the same
server, configuration, binary and browser assets must have identical per-engine
case states, counts, violations and rule facts, including geometry. No equality
between different engines is required.

## Recorded evidence

The initial compiled clipping tracer failed: WebKit inspected zero elements and
failed its minimum, whereas Chromium and Firefox found `#ink`. Direct Playwright
observation in the same container showed WebKit had no `overflowClipMargin`
computed-style property. After using the public CSS property lookup with its
unsupported-property default, the tracer passed in all three engines (10
assertions). The expanded matrix passed 559 assertions, 1 test, 0 failures in
63.66 seconds. Typecheck and architecture checks (43 modules) also passed.

Host browser dependencies remain unavailable; this is isolated Linux browser
acceptance, not validation of native Windows/macOS/iPhone hardware or every host
Linux distribution. No browser install, installer update or release behavior is
claimed by this ticket. The container, image and ignored build output remain for
parent acceptance; final independent full-spec review is parent-owned.
