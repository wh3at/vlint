# vlint

`vlint` detects DOM-geometry layout violations — such as wrapped tab labels — on a
finite set of declared UI targets, **without** sending images to an LLM. An AI agent
runs one command, reads structured diagnostics to locate the offending target and
element, fixes the layout, and re-runs until clean.

> **Distribution artifact: Linux x64.** Playwright prepares the managed browser
> executables and determines actual host prerequisites and launch availability.

---

## Table of contents

- [Install](#install)
- [Browser setup](#browser-setup)
- [Command help](#command-help)
- [Running checks](#running-checks)
- [Configuration](#configuration)
- [Local rule plugins](#local-rule-plugins)
- [Browser state (authentication)](#browser-state-authentication)
- [Output: terminal vs JSON](#output-terminal-vs-json)
- [Exit codes](#exit-codes)
- [Machine consumption (JSON)](#machine-consumption-json)
- [Consumer integration](#consumer-integration)
- [Building from source](#building-from-source)
- [Security notes](#security-notes)
- [Limitations](#limitations)

---

## Install

Use the same installer for first installation and updates. No Node.js, Bun or
npm runtime is required. Pin `TAG=vX.Y.Z` for CI instead of resolving latest.
The Linux x64 artifact is the only distributed platform.

### Common installer

```sh
TAG="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/wh3at/vlint/releases/latest)"
TAG="${TAG##*/}"
base="https://github.com/wh3at/vlint/releases/download/$TAG"
curl -fsSLO "$base/install-$TAG.sh"
sh "install-$TAG.sh"
export PATH="${VLINT_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
vlint init
vlint check --url http://localhost:3000/
```

The installer verifies the archive checksum, stages the candidate executable,
and uses Playwright to prepare OS dependencies and all three managed engines.
It launch-checks each engine with an empty page before atomically replacing
the installed executable. If preparation, launch or interruption fails, the
previous executable remains installed and the failure is reported. Browser
garbage collection is disabled during preparation to preserve older assets.
Playwright may request privileges; OS package changes are not rolled back.

The default destination is `$HOME/.local/bin`; override `VLINT_INSTALL_DIR` if
needed. If it is not on `PATH`, the installer prints the directory to add.
After installation, use `vlint init --help` to select project environments.
Use `vlint browser install --force` for repair; `.deb` and `setup` are retired.
The archive contains `vlint` (mode `0755`) and `README.md`. `SHA256SUMS` is an
integrity check, not a signature.

## Browser setup

`vlint browser install` prepares the Chromium headless shell, Firefox, and WebKit
required by this vlint build. Playwright owns browser downloads, host dependency
preparation and validation, and any required privilege prompt. There is no
separate dependency flag, engine selection, or independent version selection.
A host is not rejected by vlint merely because its distribution is not Ubuntu;
Playwright's actual preparation and launch results determine availability.

```sh
vlint browser install
vlint browser install --force
vlint browser status --format json
```

`--force` repairs all three managed engines. `browser status` requires no project
configuration, downloads nothing, and does not install or repair dependencies.
It launches each engine, creates and closes an empty page, and closes the browser.
It exits 0 only when all three engines pass, otherwise 2; one unavailable engine
does not prevent status from probing the others. `check` never installs browsers.

Status JSON separates expected and obtained versions, version source, revision,
Playwright-selected artifact and executable, execution host, dependency validation,
launch, empty-page, and close results. Unavailable values remain null rather than
being guessed. WebKit's `browser.version()` is identified as Playwright metadata,
not independent binary verification; that provenance alone does not make it fail.

The compiled three-engine preparation and offline status acceptance can be run
in the existing Ubuntu 24.04 Docker fixture approach:

```sh
bun run build:linux-x64
VLINT_BROWSER_CONTAINER_ACCEPTANCE=1 bun test tests/acceptance/browser-management-container.test.ts
```

This is an isolated validation environment, not a supported container distribution.
The test uses a private browser cache with garbage collection disabled and removes
only its own container. It exercises initial and repeated preparation, forced repair,
offline launch readiness, and an executable-present launch failure.

## Command help

```sh
vlint --help
vlint check --help
vlint browser --help
vlint browser install --help
vlint browser status --help
vlint init --help
```

Run `vlint` with no arguments for the top-level overview.

## Running checks

Every check requires a project-local `vlint.config.json`; run `vlint init` first.

```sh
vlint check --url http://localhost:3000/
vlint check
vlint check --format json
```

- `--url` uses the declared environment/device combinations but does not resolve a target provider.
- Without `--url`, the config must contain a `static` or `command` provider.
- One case failing does not stop the rest; the run is reported as `incomplete` (see [Exit codes](#exit-codes)).
- The caller starts the target app and prepares fixtures and authentication state; vlint does not start dev servers, generate fixtures, or perform logins.

## Configuration

`vlint.config.json` (valid JSON, read from the current working directory) is the only
configuration source. In a terminal, `vlint init` asks for a platform, then its
browser; repeat and enter `done` to finish. Automation must select explicitly:

```sh
vlint init --environment windows:chromium --environment iphone:webkit
vlint init --help
```

Valid choices are `windows:chromium`, `windows:firefox`, `macos:chromium`,
`macos:webkit`, `iphone:webkit`, and `android:chromium`. Repeated flags select
only those environments and bypass prompts even in a terminal. Without a terminal
and selections, init fails with guidance rather than choosing defaults.
Generated devices contain editable concrete viewport, screen, DPR, mobile and
touch values from public Playwright desktop/mobile presets; User-Agent is not
stored. Each generated environment references its device. Existing files,
directories and symlinks at the config path are never overwritten or migrated.

```jsonc
{
  "devices": [{ "name": "desktop", "viewport": { "width": 1280, "height": 720 }, "screen": { "width": 1280, "height": 720 }, "deviceScaleFactor": 1, "isMobile": false, "hasTouch": false }],
  "environments": [{ "name": "windows-chrome", "platform": "windows", "browser": "chromium", "devices": ["desktop"] }],
  "defaults": { "locale": "en-US", "timezoneId": "UTC", "timeoutMs": 30000 },
  "rules": [
    { "name": "tab-label-single-line", "type": "tab-label-single-line" },
    { "name": "page-horizontal-overflow", "type": "page-horizontal-overflow" },
    { "name": "table-header-single-line", "type": "table-header-single-line" },
    { "name": "table-cell-text-overlap", "type": "table-cell-text-overlap" },
    { "name": "svg-text-clipping", "type": "svg-text-clipping" }
  ],
  "provider": {
    "type": "static",
    "targets": [{ "name": "settings", "url": "http://localhost:3000/settings" }]
  }
}
```

| Field | Description |
| --- | --- |
| `devices` | Device profiles with unique names; authority for viewport, screen, DPR, mobile and touch. Device `userAgent` is forbidden. |
| `environments` | Required non-empty ordered list of unique `name`, `platform`, `browser`, and non-empty `devices` references. |
| `defaults` | `locale`, `timezoneId`, `timeoutMs`, `readyCondition`, `browserState`. |
| `rules` | Built-in and local rule instances. |
| `provider` | Optional `static` or `command` provider; required only without `--url`. |

### Declared environments

Supported combinations are `windows:chromium`, `windows:firefox`, `macos:chromium`,
`macos:webkit`, `iphone:webkit`, and `android:chromium`. Browser names refer to
Playwright-managed engines, not installed branded browsers. The execution host
need not match the declared platform. Unknown device references, unsupported
combinations and duplicate environment names are configuration errors. Old
configurations without environments are rejected; there is no implicit Chromium mode.

Cases are planned in target order, environment order, then device-reference order.
Environments may share devices; unreferenced devices are not checked. Targets and
rules are common to every environment; there are no environment-specific overrides.
Minimums are checked independently per case, never pooled across environments.

UA comes from Playwright's public `Desktop Chrome`, `Desktop Firefox`, `Desktop Safari`,
`iPhone 17`, or `Pixel 10` preset. macOS Chromium uses a macOS UA constructed with
the managed Chromium version. Missing required presets fail rather than substitute.
Explicit device screen options are passed unchanged through Playwright's public
context API; preset screen values never overwrite them. This is emulation, not
a guarantee of physical OS/device signals. See [measured engine limits](docs/operations/environment-execution-validation.md).

Only selected engines launch. A missing or unusable engine fails its own cases
while other engines continue. `check` never downloads, installs, repairs or falls
back to another engine/version.

The complete result's `execution` metadata separates the actual `host`, selected
`engines` (expected/obtained version, version source, revision, artifact, executable
and launch diagnostic), environment UA, and referenced device configurations.
Cases refer to environment names and device names rather than copying those
shared values. Device metadata records options supplied to Playwright, not an
independent observation of browser signals. WebKit's version source is explicitly
`playwright-metadata`, not independent binary verification.

- **`tab-label-single-line`** — each rendered tab label must fit on one line. Fields: `additionalCandidateSelectors`, `excludeSelectors`, `labelSelector`.
- **`page-horizontal-overflow`** — detects unintended root-page horizontal scroll attributed to light-DOM elements. Field: `tolerancePx` (`0`–`100`, default `1`).
- **`table-header-single-line`** — each rendered semantic column header must fit on one line. Fields: `additionalCandidateSelectors`, `excludeSelectors`, `lineTopTolerancePx`.
- **`table-cell-text-overlap`** — detects visible text entering an adjacent cell in the same table/grid. Fields: `enabled` (default `true`), `excludeSelectors` (default `[]`).
- **`svg-text-clipping`** — detects SVG text ink extending beyond rectangular clip boundaries. Fields: `enabled`, `excludeSelectors`, `tolerancePx` (CSS pixels, `0`–`100`, default `1`).
- **`static`** provider — inline `targets` (`name`, `url`, defaults, optional `ruleOverrides`).
- **`command`** provider — runs a trusted executable without a shell, reads `{"targets":[...]}` from stdout (`executable`, `args`, `timeoutMs`).

### SVG text clipping rule

Enabled by default, even when omitted from `rules`; `init` also includes it.
Discovers light-DOM SVG `<text>` without chart-specific selectors. Intentional
clipping is reported too: opt out with `excludeSelectors`, matching the text or
an ancestor. A named instance suppresses the injected default. As with the cell
rule, an existing rule using the default name reserves that name.

```jsonc
{ "name": "svg-labels", "type": "svg-text-clipping",
  "tolerancePx": 1, "excludeSelectors": [".intentionally-cropped"],
  "minimumInspected": 1 }
```

A target can disable the named rule or append exclusions:

```jsonc
{ "name": "chart", "url": "http://localhost:3000/chart",
  "ruleOverrides": { "svg-labels": { "enabled": false, "excludeSelectors": ["#annotation"] } } }
```

The rule measures Canvas `measureText()` ink-oriented `actualBoundingBox*` metrics
using the SVG font, weight, style, kerning and size, positions them from the SVG
first-character baseline origin (including `text-anchor`), and maps them through
`getScreenCTM()` to CSS pixels. SVG advance length is checked for compatibility;
advance agreement alone is not a guarantee of equivalent placement. Neither SVG
`getBBox()` nor character-cell BCRs determine violations, and there is no cell-box
fallback. Fully clipped text remains measurable without changing the document.

Supported scope: a direct text run or a single leaf `tspan` containing all rendered
text (only indentation whitespace may surround it in the parent `text`). The run
must be single-style, left-to-right horizontal writing with normal whitespace
collapsing, default/alphabetic baseline, no custom letter/word spacing, positive
axis-aligned scaling and translation, `viewBox`, and start/middle/end anchors.
For the single-`tspan` structure, scalar x/y/dx/dy on parent and child, including
`em` offsets, use browser-resolved layout and the child's computed font/paint style.
The child's font family and size may differ from the parent's.
The parent `text` counts once and remains the diagnostic target.
Rectangular SVG viewport overflow and
HTML block/flex/grid/table-container `overflow: hidden / clip` are compared on
each clipping axis, accounting for borders, padding and scale. Root/body overflow
propagated to the viewport uses the viewport boundary rather than the body box.
All applicable clip ancestors are considered independently. Ordinary `auto / scroll` regions
are not violations merely because the current scroll position hides text;
their reachable ink positions are constrained by scrollports when checking outer clips. No
scrolling or other interaction is performed.

Unsupported text is silently excluded as a whole, including when a supported
rectangle is also present. This includes multiple/nested `tspan`, `textPath`,
mixed rendered text across parent and child, x/y/dx/dy lists, dx/dy on direct text runs,
rotate, `textLength`, other baselines,
vertical/RTL or bidi text, paint-server fills (`fill: url(...)`, including fallback
colors), stroke, shadow, decoration, custom font stretch or
size adjustment, font feature/variation/caps settings, rotations, skew, reflection,
perspective/3D transforms, arbitrary `clip-path` / SVG `clipPath`, masks, filters,
paint containment, rounded overflow clips (including scrollports), non-default
overflow clip margins, and content-visibility optimization. Also excluded are
`foreignObject` subtrees, absolute/fixed/sticky HTML or SVG viewport ancestors,
RTL scrollers, and nested SVG viewports with their own transform/translate/scale
or CSS geometry differing from their SVG length attributes. Nested CSS geometry
must resolve to pixel lengths (or `auto`); unresolved percentages/expressions are excluded.
Untransformed nested SVG viewports and transformed `g`/`text` runs remain supported.
An advance incompatible with Canvas is also outside the supported scope.
Non-painted, empty, transparent or zero-viewport text and text in SVG definition
containers (`defs`, `symbol`, `clipPath`, `mask`, `pattern`, `marker`) are ignored.
Shadow DOM, embedded SVG images, occlusion, ellipsis and line-clamp are not checked.

JSON and terminal diagnostics include `text`, unique `locator`, ink `geometry`,
`clipLocator`, `clipGeometry`, `directions`, `overflowPx` for all four sides, and
`tolerancePx`. Geometry and distances are CSS pixels; an excess must be strictly
greater than the tolerance to report. One text can report multiple clip sources
but counts only once in `elementsInspected`. Excluded and unsupported text do
not count. Zero candidates is valid unless a positive minimum was declared.
Unsupported conditions produce no diagnostic or failure and do not alone make
a run `incomplete`. A supported measurement failure is an ordinary rule failure,
not a violation or a successful zero count.

A clean result means no violations **within this supported scope**, not that all
SVG text is intact. Canvas bounds are not pixel-perfect glyph-loss detection:
rasterization, anti-aliasing and scaling can differ from the measured outline.
DPR 1/2 image controls in tests verify placement and a cell-only boundary crossing;
they are not part of product detection or a universal accuracy guarantee.


### Table header single-line rule

The rule is enabled by default. If no `table-header-single-line` instance is declared,
vlint injects one named `table-header-single-line` with `lineTopTolerancePx: 1`.
Declaring one or more named instances suppresses that injected default.

It discovers rendered native column headers from `th[scope="col"]`,
`th[scope="colgroup"]`, and `thead th`, plus explicit ARIA
`[role="columnheader"]` elements. Native `th[scope="row"]`,
`th[scope="rowgroup"]`, and `[role="rowheader"]` elements are not candidates.
Additional selectors extend discovery; overlapping selectors inspect an element only once.

```jsonc
{
  "name": "tables",
  "type": "table-header-single-line",
  "additionalCandidateSelectors": ["[data-column-heading]"],
  "excludeSelectors": [".allow-header-wrap"],
  "lineTopTolerancePx": 1,
  "minimumInspected": 1
}
```

Use `excludeSelectors` as the intentional-wrap opt-out. Exclusions apply to the
header candidate itself, and JSON `candidateDiagnostics` records the first matching
selector. A header with significant rendered `::before` or `::after` content is
reported as `generated-content-unmeasured` and is not counted as inspected; other
headers in the case are still evaluated.

`minimumInspected` is an optional per-target/device/rule lower bound. Without a
declaration, zero inspected headers is valid. A target can add exclusions or disable
the named rule with `ruleOverrides`:

```jsonc
{
  "name": "legacy-report",
  "url": "http://localhost:3000/report",
  "ruleOverrides": { "tables": { "enabled": false, "excludeSelectors": [".legacy-wrap"] } }
}
```

### URL and minimum-count contract

The configured target URL must match the browser's arrival URL after standard URL
normalization (scheme, host, default port, path, query, and fragment). An initial
HTTP redirect may be declared as a full URL in that target's `allowedUrls`;
only an exact normalized match is allowed. Once acquired, the arrival URL is fixed
for every rule: a later transition, even to another allowed URL, is incomplete.
This applies to static and command providers and `--url` (which has no allowlist).

Declare positive minimums only for rules expected to inspect elements. Rules
without a minimum may legitimately report zero. `page-horizontal-overflow` is a
page-wide rule: positive `minimumInspected` is invalid. Local rules report their
own count; vlint validates the report but cannot prove the plugin inspected that
many DOM elements. Disabled rules do not count as inspected.

```jsonc
{
  "devices": [
    { "name": "desktop", "viewport": { "width": 1280, "height": 720 }, "screen": { "width": 1280, "height": 720 }, "deviceScaleFactor": 1, "isMobile": false, "hasTouch": false, "ruleMinimums": { "tabs": 2 } },
    { "name": "phone", "viewport": { "width": 390, "height": 720 }, "screen": { "width": 390, "height": 720 }, "deviceScaleFactor": 1, "isMobile": true, "hasTouch": true }
  ],
  "environments": [{ "name": "windows-chrome", "platform": "windows", "browser": "chromium", "devices": ["desktop", "phone"] }],
  "rules": [{ "name": "tabs", "type": "tab-label-single-line", "minimumInspected": 1 }],
  "provider": { "type": "static", "targets": [{
    "name": "settings", "url": "http://localhost:3000/settings",
    "allowedUrls": ["http://localhost:3000/settings/"],
    "ruleOverrides": { "tabs": { "minimumInspected": 2 } },
    "deviceRuleMinimums": { "phone": { "tabs": 3 } }
  }] }
}
```

Precedence is exact target/device combination, target rule override, device
`ruleMinimums`, then rule `minimumInspected`. If target and device values
disagree, the combination must be explicit or configuration fails. Unknown
device/rule names and invalid counts also fail configuration. On `--url`,
device and rule minimums still apply, but named target overrides do not.

Migration from 0.7 to 0.8: replace `minimumLabels` and `minimumHeaders` at rule
or target level with `minimumInspected`; replace `allowZeroLabels: false`
and `allowZeroHeaders: false` with explicit positive minimums on the intended
cases. Remove the old fields entirely: they are configuration errors now.
The run-wide zero-count check is gone. A missing minimum can yield a clean
result even when a case inspected zero elements.

Line counts come from rendered DOM text geometry in each active viewport, not from
the computed `white-space` value or decorative element boxes. The same header can be
clean on a desktop profile and violate on an iPhone-width profile; the violation
reports its source, locator, box, text, line count, measured line tops, and tolerance.

### Table cell text overlap rule

Enabled by default, including when `rules` omits it. Checks native `th`/`td` and
ARIA `table`/`grid` row, rowheader, columnheader, cell/gridcell pairs. A cell is
reported only if rendered DOM text intersects a geometrically adjacent cell
in the same table/grid, including cells across a `rowspan` or a row boundary.
The check measures `Range.getClientRects()` after layout and clips fragments
against applicable ancestor overflow, paint containment, the viewport, and the
`clip-path` shapes `inset()`, `xywh()`, `circle()`, `ellipse()`, `polygon()`,
including the `closest-side`/`farthest-side` radius keywords and a `calc()` length or
percentage built from `+`, `-`, `*` and `/`, `round` corners normalised
against the resulting rectangle, `path("...")`, and `url(#id)` references built from SVG
`rect` (with `rx`/`ry` clamped per axis), `circle`, `ellipse`, `polygon`, `polyline`, and
`path` shapes, with their own transforms and `clipPathUnits`. A negative `r`, `rx`, or `ry`
is an SVG error, so an `ellipse` draws from the other axis' radius while a `circle` draws
nothing. An SVG length accepts `px`,
`in`, `cm`, `mm`, `q`, `pt`, `pc`, and `em`; a percentage resolves against the SVG viewport
(its `viewBox` size when set, its rendered size otherwise) or, under
`clipPathUnits="objectBoundingBox"`, against the normalized element box. Any other unit,
an expression the engine cannot reduce, and a `clip-path` that names a shape this rule
cannot read, leave the shape unmodelled rather than empty; a `url(#id)` reference
containing one such element is ignored as a
whole, while a `clipPath` with no shape hides the referenced text. An ancestor `transform` scales the overflow and `clip-path` bounds to match the
rendered text. A non-rectangular shape is sampled on a grid of at most four CSS pixels,
capped at 64 samples per axis, so a partly clipped fragment is reported only where that
shape still shows it. Text that wraps inside its cell or is hidden by
`overflow: hidden` on a block, flex or grid container box, ellipsis, or an internal scroller is
not reported. A `border-radius` on that box rounds the clip where both axes clip, so a corner
that cuts the text away is not reported either, while one clipped axis beside a visible one
keeps the plain rectangle; a non-replaced inline box generates no overflow clip and does not
hide its text.
An overlay opened from inside the source cell (`[role="tooltip"]`, `[role="dialog"]`, or
`[popover]`), a text-backed icon (a descendant marked `[role="img"]` or `[aria-hidden="true"]`),
and generated pseudo-element text are not measured, while a table hosted inside such an overlay
still is. An `aria-hidden` cell or ancestor still paints its own text, so that text is measured.
Unmarked positioned body text is measured even when it starts outside its source cell. The default
threshold is greater than 1 CSS pixel.

The violation supplies `locator`, `geometry` (source cell), `adjacentLocator`
(neighbor cell), and `overlapPx` (visible penetration into that cell). The
rule is local to cells: `table-header-single-line` instead counts *column-header
lines*, and `page-horizontal-overflow` instead detects *root-page horizontal
scroll*. Neither needs to fail for this rule to report a collision.

To opt out of known intentional cell content on one target:

```jsonc
{ "name": "report", "url": "http://localhost:3000/report",
  "ruleOverrides": { "table-cell-text-overlap": { "excludeSelectors": [".intentional-overlap"] } } }
```

Set `enabled: false` in the rule declaration to disable it everywhere, or
`enabled: false` in a target's `ruleOverrides` to disable it for that target.


## Local rule plugins

Register trusted, self-contained TypeScript rules in `vlint.config.json`; they run
with the same scheduling and output surfaces as built-in rules.

```jsonc
{
  "name": "duplicate-spacing",
  "type": "local",
  "path": ".vlint/rules/duplicate-spacing.ts",
  "settings": { "shellSelector": "#app-shell", "contentSelector": "#content" }
}
```

The authoring contract is not exposed by the CLI, so it is documented here. One
self-contained TypeScript file per rule — no relative-module or package imports
(vlint loads it through its embedded Bun runtime). Each file default-exports
`contractVersion`, `metadata`, `settingsSchema`, `evaluate`, and optional `finalize`.
The smallest useful rule inspects one known element and reports a violation — save it
as `.vlint/rules/minimum-size.ts`:

```ts
export default {
  contractVersion: 1,
  metadata: { name: "minimum-size" },
  settingsSchema: { type: "object", exactKeys: [] },
  evaluate: async () => {
    const element = document.querySelector("[data-vlint-check]");
    if (element === null) return { elementsInspected: 0, violations: [] };

    const rect = element.getBoundingClientRect();
    return {
      elementsInspected: 1,
      violations: rect.width >= 44 && rect.height >= 44 ? [] : [{
        message: "element is smaller than 44 × 44 CSS pixels",
        locator: "[data-vlint-check]",
        geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        details: {},
      }],
    };
  },
};
```

`evaluate` returns `{ elementsInspected, violations }`, where each violation is the
`local` envelope of `message`, `locator`, `geometry`, and `details`. Target overrides
may set `enabled` and a JSON `settings` overlay.

## Browser state (authentication)

For authenticated pages, supply a Playwright storage-state file produced **by the
caller** via `browserState` in `defaults` or on a target (path resolved relative to
the config directory). vlint never logs in, stores credentials, handles MFA, or
solves CAPTCHAs.

---

## Output: terminal vs JSON

`--format terminal` (default) and `--format json` show the same concise coverage:
overall status, case partitions, environment-by-rule execution and inspected-element
counts, and actionable failures/violations. Disabled and unexecuted evaluations are
counted separately. Inspected elements are summed rule observations, not unique DOM
nodes. Successful case detail is omitted from normal output.

Both formats identify the complete same-run JSON file with `reportPath`. That file
retains all cases, rule facts and common execution metadata; reading it does not
rerun the inspection. Terminal escapes control characters. Diagnostic URLs and all
report URLs retain raw query values and fragments. Before browser arrival,
`actualUrl` is null. Do not put secrets in URLs or publish reports indiscriminately.
See [complete reports and CI retention](docs/operations/reports.md).

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every enabled rule completed on its declared page and satisfied its declared minimum, with no layout violations (`clean`). |
| `1` | All targets inspected with violations (`violations`), or invalid CLI usage. |
| `2` | Incomplete inspection: configuration, browser, URL mismatch, ready state, count, rule, or other execution failure. Observed layout violations may still be included. |

A completed check with violations writes its normal result to stdout and exits `1`.

---

## Machine consumption (JSON)

`vlint check --format json` emits one newline-terminated summary object per run;
pin the vlint version you parse against. Its fields are:

- `status`, `tool`, and `summary`: verdict, tool version, case/rule/count partitions.
- `environmentRules`: each environment/rule's execution, inspection, clean,
  violating, failed, disabled and unexecuted counts.
- `diagnostics`: affected target, environment and device identities, specified and
  observed URLs, failures and violating/failed rules.
- `executionDiagnostics`: affected engine/environment configuration when relevant.
- `ruleFinalizations` and `failures`: failing finalizations and run-wide failures.
- `reportPath`: the private full report filename, or null when persistence failed.

Normal stdout does not contain the full `cases` or `execution`. Read `reportPath`
for those fields. Full report cases are ordered by target, declared environment,
then that environment's device-reference order. Case devices contain their names;
common emulation settings live in `execution.devices`, UAs in
`execution.environments`, and actual host/engine version information in
`execution.host` / `execution.engines`. A failed rule retains its independent later
rule results; URL/ready/font boundary failure stops that case's remaining rules.

Local violations carry `message`, `locator`, `geometry`, and `details`. Table-header
violations include `candidateSource`, `text`, `lineCount`, `lineTops`,
`lineTopTolerancePx`, `geometry`, and `locator`. Rule `candidateDiagnostics` retain
exclusions without turning them into violations. Table-cell overlap violations add
`adjacentLocator` and `overlapPx`; SVG violations identify their clip and directions.
The complete report retains successful facts and candidate diagnostics as well.

---

## Consumer integration

vlint does not manage your CI or git hooks; add it to your existing checks:

```sh
vlint browser install              # once, in a network-enabled step
vlint check --format json          # in the step that runs your checks
```

Preflight without downloading: `vlint browser status --format json` (exits `0` when
ready). Neither status nor check installs, downloads or repairs missing engines.
Use explicit `browser install` (or `browser install --force` for repair). Gate on
the check exit code, inspect the same-run report, fix the layout, then re-run to
verify the fix. Copy temporary reports for durable CI retention as described
[here](docs/operations/reports.md). The integrated artifact validation record is
[here](docs/operations/integrated-artifact-66-validation.md); it distinguishes
completed Linux x64 acceptance from engine emulation and host-support limits.

---

## Building from source

Development uses the exact Bun version declared in `package.json` → `engines.bun`.
The project-local `mise.toml` selects that version without changing global tools:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run build:linux-x64
```

The binary is written to `dist/vlint-linux-x64`. If your shell already selects the
required Bun version, plain `bun` commands work too. From the repository root,
package validation/build scripts and direct `bun test` commands stop on a version
mismatch before doing work. Unit tests check that the mise and CI pins match
`package.json`. This is a development guard, not a requirement on users of the
compiled executable.

```sh
mise exec -- bun run typecheck
mise exec -- bun test tests/integration/svg-text-clipping-pairs.test.ts
mise exec -- bun run test:all
```

SVG geometry controls exercise the public rule evaluator in
`tests/integration/svg-text-clipping-pairs.test.ts`. Their small scene generator
is `tests/fixtures/svg-text-clipping.ts`; expected outcomes remain explicit in
the tests. The controls pair joint translation, overlapping/touching/separated
scrollports, pixel/percentage units, and supported/unsupported clip combinations.

`bun run release:validate` (Docker) exercises the archive in a clean Ubuntu 24.04 x64
guest; `bun run test:feasibility` runs the compiled-Playwright feasibility probe.

The required three-engine and privilege CI gates also have local entrypoints:
`bun run test:acceptance:three-engine` and `bun run test:acceptance:privilege`.
Both consume the compiled binary and own their disposable Docker environments.

Releases use a reviewed Release Please PR for the version and changelog. PRs must have
Conventional Commit titles; squash merges preserve those titles on `main`. See
[Release operations](docs/operations/release.md) for classification, approval,
publication, and recovery.

---

## Security notes

- Command Provider and local rule plugins run trusted code; even the Static Provider executes target page JavaScript. Inspect untrusted worktrees or pages in a **credential-free, disposable container**.
- Browser state files are credentials, and JSON output may contain sensitive rendered content — keep them short-lived and do not persist output from authenticated pages.
- Both configured and actual URLs, including query values and fragments, are logged in terminal and JSON. Never place secrets in target URLs.

---

## Limitations

- **Linux x64 distribution only.** Playwright determines actual host prerequisites and availability.
- Inspects exactly the declared target set — no route discovery or full-site coverage.
- No screenshot comparison, image understanding, pixel-diff, or click/input/scroll interaction.
- Each rule checks the fixed target URL, font loading completion, and any declared `readyCondition` only at the start and end of its evaluation. A failed boundary check returns `incomplete` and discards that rule's facts. Changes during evaluation are not monitored: temporary URL changes, document reloads, hide/show, ready-element replacement, and font loading are allowed if the final boundary satisfies all conditions. Without `readyCondition`, no application-specific readiness is checked. Initial page acquisition still validates redirects and waits for loading, fonts, and the declared ready condition.
- Boundary checks sample the current ready matching set, then the URL and font status through browser automation. They are not an atomic snapshot or a guarantee that the page stays unchanged between those reads or after a check.
- The caller still owns application startup, login, fixtures, route enumeration, and CI orchestration.
