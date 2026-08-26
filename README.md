# vlint

`vlint` detects DOM-geometry layout violations — such as wrapped tab labels — on a
finite set of declared UI targets, **without** sending images to an LLM. An AI agent
runs one command, reads structured diagnostics to locate the offending target and
element, fixes the layout, and re-runs until clean.

> **Supported platform: Ubuntu 24.04 x64 only.** vlint does not bundle a browser
> executable.

---

## Table of contents

- [Install](#install)
- [OS prerequisites](#os-prerequisites)
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

Pick one version-pinned path. None requires Node.js, Bun, npm, or another runtime.

### Ubuntu package (`.deb`)

Installs vlint and declares all required Chromium shared libraries:

```sh
VERSION=0.4.0
TAG="v$VERSION"
base="https://github.com/wh3at/vlint/releases/download/$TAG"
curl -fsSLO "$base/vlint_${VERSION}_amd64.deb"
curl -fsSLO "$base/SHA256SUMS"
awk -v name="vlint_${VERSION}_amd64.deb" '$2 == name { print }' SHA256SUMS | sha256sum -c -
sudo apt install "./vlint_${VERSION}_amd64.deb"
vlint setup
vlint check --url http://localhost:3000/
```

### User-local installer (no sudo)

```sh
VERSION=v0.4.0
base="https://github.com/wh3at/vlint/releases/download/$VERSION"
curl -fsSLO "$base/install-$VERSION.sh"
sh "install-$VERSION.sh"
export PATH="${VLINT_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
vlint browser install --with-deps   # only Playwright's apt subprocess elevates
vlint init
vlint check --url http://localhost:3000/
```

If the destination is not on `PATH`, the installer prints the directory to add.

### Manual fallback

```sh
VERSION=v0.4.0
base="https://github.com/wh3at/vlint/releases/download/$VERSION"
archive="vlint-$VERSION-linux-x64.tar.gz"
curl -fsSLO "$base/$archive"
curl -fsSLO "$base/SHA256SUMS"
awk -v name="$archive" '$2 == name { print }' SHA256SUMS | sha256sum -c -
tar -xzf "$archive"
install -m 0755 vlint "$HOME/.local/bin/vlint"
```

The archive contains only `vlint` (mode `0755`) and this `README.md`. `SHA256SUMS`
is an integrity check, not a signature.

## OS prerequisites

- The `.deb` resolves Ubuntu packages through APT.
- `vlint browser install --with-deps` installs them before the browser payload.
- For locked-down hosts, install manually:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0t64 \
  libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
  libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2
```

## Browser setup

Browser acquisition is always a separate, explicit operation; `vlint check` never
downloads or installs a browser.

```sh
vlint browser status                # readiness without downloading (--format json for CI)
vlint browser install               # pinned Chromium headless shell
vlint browser install --force       # repair/reinstall
vlint browser install --with-deps   # Ubuntu libraries, then browser payload
```

`vlint setup` is the first-run convenience: it creates `vlint.config.json` only when
absent and installs the browser payload, preserving an existing valid config.

## Command help

```sh
vlint --help
vlint check --help
vlint browser --help
vlint browser install --help
vlint browser status --help
vlint init --help
vlint setup --help
```

Run `vlint` with no arguments for the top-level overview.

## Running checks

Every check requires a project-local `vlint.config.json`; run `vlint init` or
`vlint setup` first.

```sh
vlint check --url http://localhost:3000/  # every configured device, one URL
vlint check                               # every provider target × every device
vlint check --format json
```

- `--url` uses the configured devices but does not resolve a target provider.
- Without `--url`, the config must contain a `static` or `command` provider.
- One case failing does not stop the rest; the run is reported as `incomplete` (see [Exit codes](#exit-codes)).
- The caller starts the target app and prepares fixtures and authentication state; vlint does not start dev servers, generate fixtures, or perform logins.

## Configuration

`vlint.config.json` (valid JSON, read from the current working directory) is the only
configuration source. Run `vlint init` to generate the standard MacBook Air 13-inch
and iPhone 17 profiles.

```jsonc
{
  "devices": [/* from `vlint init` */],
  "defaults": { "locale": "en-US", "timezoneId": "UTC", "timeoutMs": 30000 },
  "rules": [
    { "name": "tab-label-single-line", "type": "tab-label-single-line" },
    { "name": "page-horizontal-overflow", "type": "page-horizontal-overflow" },
    { "name": "table-header-single-line", "type": "table-header-single-line" }
  ],
  "provider": {
    "type": "static",
    "targets": [{ "name": "settings", "url": "http://localhost:3000/settings" }]
  }
}
```

| Field | Description |
| --- | --- |
| `devices` | Ordered device profiles with unique names; authority for viewport, screen, DPR, mobile, touch, optional `userAgent`. |
| `defaults` | `locale`, `timezoneId`, `timeoutMs`, `readyCondition`, `browserState`. |
| `rules` | Built-in and local rule instances. |
| `provider` | Optional `static` or `command` provider; required only without `--url`. |

- **`tab-label-single-line`** — each rendered tab label must fit on one line. Fields: `additionalCandidateSelectors`, `excludeSelectors`, `labelSelector`, `minimumLabels`, `allowZeroLabels`.
- **`page-horizontal-overflow`** — detects unintended root-page horizontal scroll attributed to light-DOM elements. Field: `tolerancePx` (`0`–`100`, default `1`).
- **`table-header-single-line`** — each rendered semantic column header must fit on one line. Fields: `additionalCandidateSelectors`, `excludeSelectors`, `lineTopTolerancePx`, `minimumHeaders`, `allowZeroHeaders`.
- **`static`** provider — inline `targets` (`name`, `url`, defaults, optional `ruleOverrides`).
- **`command`** provider — runs a trusted executable without a shell, reads `{"targets":[...]}` from stdout (`executable`, `args`, `timeoutMs`).

### Table header single-line rule

The rule is enabled by default. If no `table-header-single-line` instance is declared,
vlint injects one named `table-header-single-line` with `lineTopTolerancePx: 1`,
`minimumHeaders: 0`, and `allowZeroHeaders: true`. Declaring one or more named
instances suppresses that injected default.

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
  "minimumHeaders": 1,
  "allowZeroHeaders": false
}
```

Use `excludeSelectors` as the intentional-wrap opt-out. Exclusions apply to the
header candidate itself, and JSON `candidateDiagnostics` records the first matching
selector. A header with significant rendered `::before` or `::after` content is
reported as `generated-content-unmeasured` and is not counted as inspected; other
headers in the case are still evaluated.

`minimumHeaders` is enforced for each target-device case. `allowZeroHeaders: false`
is a separate run-wide coverage check: it makes a completed run incomplete when every
enabled case inspected zero headers. The default `true` keeps table-free projects
clean. A target can replace its minimum, add exclusions, or disable the named rule:

```jsonc
{
  "name": "legacy-report",
  "url": "http://localhost:3000/report",
  "ruleOverrides": {
    "tables": {
      "enabled": false,
      "excludeSelectors": [".legacy-wrap"],
      "minimumHeaders": 0
    }
  }
}
```

Line counts come from rendered DOM text geometry in each active viewport, not from
the computed `white-space` value or decorative element boxes. The same header can be
clean on a desktop profile and violate on an iPhone-width profile; the violation
reports its source, locator, box, text, line count, measured line tops, and tolerance.

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

`--format terminal` (default) prints a human-readable summary; untrusted text is
sanitized (escape stripping, length caps, URL query/fragment redaction).
`--format json` prints a structured object (see [Machine consumption](#machine-consumption-json)). JSON preserves configured URLs and rendered tab-label text exactly,
so treat output from authenticated or untrusted pages as sensitive.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All targets inspected, no violations (`clean`). |
| `1` | All targets inspected with violations (`violations`), or invalid CLI usage. |
| `2` | A valid command did not complete (config, browser, navigation, authentication, ready-condition, rule-evaluation, setup, or install failure). Observed violations are still included in JSON. |

A completed check with violations writes its normal result to stdout and exits `1`.

---

## Machine consumption (JSON)

`vlint check --format json` emits one object per run; pin the vlint version you parse
against. Violations live under each case, keyed by rule:

```jsonc
{
  "status": "clean | violations | incomplete",
  "cases": [
    {
      "target": { "name": "settings", "url": "http://localhost:3000/settings" },
      "device": { "name": "macbook-air-13-m5", "viewport": { /* … */ } },
      "status": "complete",
      "rules": [
        {
          "name": "duplicate-spacing",
          "type": "local",
          "status": "violations",
          "violations": [
            {
              "type": "local",
              "message": "duplicate horizontal spacing in content region",
              "locator": "#content",
              "geometry": { "x": 16, "y": 16, "width": 200, "height": 40 },
              "details": { "shellPaddingPx": 32, "contentPaddingPx": 32 }
            }
          ]
        }
      ]
    }
  ]
}
```

`cases` are ordered by target then device. Local violations use the `local` envelope
of `message`, `locator`, `geometry`, and `details`. Table-header violations include
`candidateSource`, `text`, `lineCount`, `lineTops`, `lineTopTolerancePx`, `geometry`,
and `locator`; optional `candidateDiagnostics` on that rule result records excluded
or generated-content-unmeasured candidates without representing them as violations.

---

## Consumer integration

vlint does not manage your CI or git hooks; add it to your existing checks:

```sh
vlint browser install              # once, in a network-enabled step
vlint check --format json          # in the step that runs your checks
```

Preflight without downloading: `vlint browser status --format json` (exits `0` when
ready). Gate on the exit code (see [Exit codes](#exit-codes)); an AI agent reads the
JSON, fixes the layout from the rule type, geometry, and locator, and re-runs.

---

## Building from source

```sh
bun install --frozen-lockfile   # requires Bun 1.3.14
bun run build:linux-x64         # dist/vlint-linux-x64
```

`bun run release:validate` (Docker) exercises the archive in a clean Ubuntu 24.04 x64
guest; `bun run test:feasibility` runs the compiled-Playwright feasibility probe.

---

## Security notes

- Command Provider and local rule plugins run trusted code; even the Static Provider executes target page JavaScript. Inspect untrusted worktrees or pages in a **credential-free, disposable container**.
- Browser state files are credentials, and JSON output may contain sensitive rendered content — keep them short-lived and do not persist output from authenticated pages.

---

## Limitations

- **Ubuntu 24.04 x64 only.**
- Inspects exactly the declared target set — no route discovery or full-site coverage.
- No screenshot comparison, image understanding, pixel-diff, or click/input/scroll interaction.
