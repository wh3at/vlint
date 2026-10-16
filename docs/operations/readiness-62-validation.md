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
case isolation, rule isolation and retention of completed evaluations. They do not
claim that every possible font failure is observable in every engine.

The implementation lane reused a private Docker snapshot of #57's prepared Ubuntu
24.04 environment and copied `/tmp/browsers-57` to `/tmp/browsers-62`. It did not
install packages on the Arch host, mutate #57's container, or delete shared caches.
