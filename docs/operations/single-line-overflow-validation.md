# Single-line and horizontal-overflow validation (#63)

The primary seam is `dist/vlint-linux-x64 check --format json`, run as a real external process against fixed loopback HTML and explicit Windows/Chromium, Windows/Firefox and macOS/WebKit environments sharing an 800×600 desktop device. Assertions read that process's complete report via stdout's `reportPath`, and check concise stdout counts against the report. No Playwright substitute or product test hook is used.

## Owned changes

Tab-label clustering limits vertical overlap to the resolved CSS line-height. Firefox 151.0 reports 21px glyph rectangles for 16px monospace text with 20px line-height: consecutive explicit lines overlap by 1px but are not one line. A direct public Playwright probe reproduced rectangles at y=7.5 and y=27.5, height=21. The compiled fixture now detects the two lines without browser-specific branches; superscript, translated badge and non-transitive clustering regressions remain covered.

Table headers containing generated text now fail with `generated-content-unsupported` instead of reporting clean/zero with an unmeasurable diagnostic. Existing measured facts, violations and candidate diagnostics remain available. Excluded generated content is still excluded, not a measurement failure. Horizontal-overflow implementation and its existing count semantics are unchanged: when root scroll width is within tolerance, no descendant scan occurs and the count is zero; overflowing pages count rendered elements, including ancestors and line-break elements, not only violating representatives.

## Reproduce

Use the approved Ubuntu 24.04 Docker isolation described in [browser management validation](browser-management-validation.md). This lane reused the fully prepared #57 container by snapshotting its filesystem into a lane-private image, then copying its browser cache into a private directory. No shared browser assets are modified or pruned.

```sh
bun install --frozen-lockfile
bun run build:linux-x64
docker commit vlint-57-validation vlint-63-validation:local
docker run -d --name vlint-63-validation --network host \
  -e PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-63 \
  -e PLAYWRIGHT_SKIP_BROWSER_GC=1 \
  -v "$PWD:/lane:ro" vlint-63-validation:local sleep infinity
docker exec vlint-63-validation cp -a /tmp/browsers-57 /tmp/browsers-63
VLINT_RULES_63_CONTAINER=vlint-63-validation bun test tests/acceptance/single-line-overflow-63.test.ts
bun run typecheck
bun run check:architecture
bun test tests/unit/geometry.test.ts tests/unit/table-header-single-line.test.ts tests/unit/page-horizontal-overflow.test.ts
docker cp "$(readlink -f "$(command -v bun)")" vlint-63-validation:/tmp/bun-63
docker exec -w /lane vlint-63-validation /tmp/bun-63 test tests/integration/table-header-single-line.test.ts tests/integration/tab-label-single-line.test.ts
docker exec -w /lane vlint-63-validation /tmp/bun-63 test tests/integration/page-horizontal-overflow.test.ts
```

The container's browser/OS dependencies came from the real compiled `browser install` in #57, following #56. Browser downloads for every check point at unreachable `http://127.0.0.1:1`. The host still lacks browser libraries and cannot perform password-requiring sudo; no host package policy was changed. This is container evidence, not a universal host-support claim.

## Observations and RED/GREEN

- Generated-header compiled RED: exit 0 instead of required 2 (`/tmp/vlint-63-red1.log`). Narrow generated-content failure handling made all three engines pass (`/tmp/vlint-63-green1.log`).
- Fixed explicit-line fixture exposed Firefox tab false-clean while Chromium/WebKit reported the violation (`/tmp/vlint-63-details.log`). After the overlap correction, three repetitions in each engine passed (`/tmp/vlint-63-green2.log`).
- The fixture asserts exact wrapped tab/header locators, two measured candidates for each single-line rule, the exact excluded-header diagnostic, and one overflow representative `#overflow` with width 1000px, breach 200px and computed width `1000px`. The overflow scan counts 22 rendered elements. Hidden tabs and row headers are not single-line candidates; separately rendered eligible clean candidates count one each; excluded-only cases count zero. A local horizontal scroll container is not page overflow.
- Three repetitions compare full measured state, counts, violations, geometry and diagnostics within each engine. Fixture URL, HTML and configuration contents remain fixed across repetitions. Firefox header line tops (119.5/139.5) legitimately differ from Chromium/WebKit (120/140); no cross-engine geometry equality is required.
- Generated-content and label-cardinality failures remain incomplete. A controlled page-owned `#unmeasurable.getBoundingClientRect` throw affects only overflow measurement, produces `rule-script-failed`, and retains successful tab/header evaluations. It does not replace normal fixture geometry or Playwright.
- Engines observed: Chromium 149.0.7827.55, Firefox 151.0, WebKit 26.5. WebKit version is Playwright metadata, not independent binary verification. Every compiled run asserts engine/environment/device correspondence and obtained/expected version metadata.
- Focused source geometry tests: 24 tests, 33 assertions. Existing real Chromium tab/header integration: 48 tests, 135 assertions; overflow integration: 8 tests, 21 assertions. These supplement, not replace, compiled three-engine evidence.

The early run also exposed generic rule-failure continuation stopping later rules. After merging #62's accepted runner fix `c647059`, the complete compiled suite passed: 5 tests, 839 assertions, 146.33 seconds (`/tmp/vlint-63-final-browser.log`), validating source/test head `a49b0eefea9aa23cade9c7e250034984b3ea4853`. It includes three repetitions of every normal, excluded-only and unmeasurable fixture plus both tab failure modes; later independent rules execute successfully. Typecheck and architecture checks passed on that head. The subsequent current-integration merge `261a377` has no source, script, dependency or #63 test differences from the validated head; no redundant full browser rerun was performed. Documentation-only follow-up records this evidence.
