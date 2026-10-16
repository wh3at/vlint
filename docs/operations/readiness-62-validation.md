# Target, readiness and font boundaries (#62)

Every selected engine uses the same target-acquisition and rule-boundary contract.
Acquisition checks the requested URL against explicitly allowed arrival URLs and fixes
that arrival URL for subsequent rules. A later move to another allowed URL is still a
failure. URL matching includes path, query and fragment.

Each rule samples the fixed URL, declared ready condition and font state before and
after evaluation. A registered FontFace with observable `error` status fails the
boundary even when `document.fonts.status` has returned to `loaded`. That evaluation's
facts are discarded. URL/font/ready failures stop remaining rules in that case; other
cases continue. Rule-specific failures retain their facts and allow independent
later rules to run. Interruption stops subsequent work.

These are samples, not continuous monitoring or atomic snapshots (ADR-0004).
Temporary URL or ready-state changes that recover by the ending boundary are allowed.
No manifest, font-family rewrite, forced loading of unused weights/subsets, or font
registration detection is provided. Cross-origin stylesheet access and character-level
font use are not guaranteed by observing the document's FontFaceSet.

## Compiled acceptance

`tests/acceptance/readiness-62-container.test.ts` runs the compiled distribution in a
Docker container sharing the host loopback network. Mount this worktree read-only at
`/lane`, prepare Playwright's three engines and OS dependencies in the container using
`/lane/dist/vlint-linux-x64 browser install`, and keep a private browser cache with
`PLAYWRIGHT_SKIP_BROWSER_GC=1`. Host browser dependencies are not required.

```sh
bun run build:linux-x64
VLINT_READINESS_CONTAINER=vlint-62-validation bun test tests/acceptance/readiness-62-container.test.ts
```

The tests use fixed loopback pages and the existing deterministic test font. They
exercise Chromium, Firefox and WebKit through external CLI processes, covering CSS
and JS font success/error, an unsettled JS font timeout, unused weight/subset requests,
redirect authorization, fixed arrival URL, persistent and roundtrip URL/ready changes,
case isolation, rule isolation and retention of completed evaluations. A separate
three-engine interruption slice sends SIGTERM to the exact compiled child PID while
two cases are evaluating; it verifies exit 2, retained completed rules and unexecuted
subsequent cases. These tests do not claim that every possible font failure is
observable in every engine.

The implementation lane reused a private Docker snapshot of #57's prepared Ubuntu
24.04 environment and copied `/tmp/browsers-57` to `/tmp/browsers-62`. It did not
install packages on the Arch host, mutate #57's container, or delete shared caches.

## Recorded implementation evidence

At source head `4d4bba50a8b35cc651d70f602d20bdb1de582bd0`, the full command above
passed: 3 tests, 142 assertions, 152.80 seconds. Typecheck and architecture checks
passed (42 modules); `bun test tests/unit/result.test.ts` passed all 33 tests.
The full unit suite had 351 passes and 4 obsolete setup-test failures awaiting #59;
those failures are not readiness or runner failures.

The late-error tracer first failed because the compiled CLI returned exit 0 instead
of 2. The rule-isolation tracer first failed because a later independent rule was
`not-executed` rather than `clean`. Both passed after their minimal fixes.
An early matrix run used a 2-second budget for every target and timed out on an
otherwise clean Firefox page under shared load. Ordinary targets now have a
10-second budget; only the deliberately stalled font retains a 2-second budget.
The final whole-file run passed with these separate budgets.
