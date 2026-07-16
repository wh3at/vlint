# vlint

`vlint` applies a common DOM-geometry layout contract to a finite set of declared UI
targets and detects layout violations — such as wrapped tab labels — **without**
sending images to an LLM. It ships as a single self-contained executable for
**Ubuntu 24.04 on x86-64 (x64)**. An AI agent runs one command and reads structured
diagnostics to locate the offending target and element.

> **Supported platform: Ubuntu 24.04 x64 only.** No other operating system,
> architecture, or browser build is covered by this release. vlint does not bundle a
> browser executable and does not auto-install one during `check`.

---

## Table of contents

- [Install](#install)
- [OS prerequisites](#os-prerequisites)
- [Browser setup](#browser-setup)
- [Command help](#command-help)
- [Running checks](#running-checks)
- [Configuration](#configuration)
- [Browser state (authentication)](#browser-state-authentication)
- [Output: terminal vs JSON](#output-terminal-vs-json)
- [Exit codes](#exit-codes)
- [Machine consumption (JSON schema v3)](#machine-consumption-json-schema-v3)
- [Browser cache hygiene](#browser-cache-hygiene)
- [Consumer integration](#consumer-integration)
- [Building from source](#building-from-source)
- [Security notes](#security-notes)
- [Limitations](#limitations)

---

## Install

vlint ships as a self-contained Ubuntu 24.04 x64 executable. Pick one
version-pinned installation path; none requires Node.js, Bun, npm, or another
language runtime.

### Quick start: Ubuntu package

The `.deb` installs vlint and declares all required Chromium shared libraries:

```sh
VERSION=0.4.0
TAG="v$VERSION"
base="https://github.com/wh3at/vlint/releases/download/$TAG"

curl -fsSLO "$base/vlint_${VERSION}_amd64.deb"
curl -fsSLO "$base/SHA256SUMS"
awk -v name="vlint_${VERSION}_amd64.deb" '$2 == name { print }' SHA256SUMS |
  sha256sum -c -
sudo apt install "./vlint_${VERSION}_amd64.deb"

# Creates vlint.config.json and installs the pinned browser payload.
vlint setup
vlint check --url http://localhost:3000/
```

### User-local installer

The version-bound installer verifies the release archive and atomically installs
`vlint` to `${VLINT_INSTALL_DIR:-$HOME/.local/bin}` without `sudo`:

```sh
VERSION=v0.4.0
base="https://github.com/wh3at/vlint/releases/download/$VERSION"
curl -fsSLO "$base/install-$VERSION.sh"
sh "install-$VERSION.sh"
export PATH="${VLINT_INSTALL_DIR:-$HOME/.local/bin}:$PATH"

# Installs Ubuntu libraries and the browser explicitly. Do not run vlint itself
# with sudo: only Playwright's apt subprocess elevates.
vlint browser install --with-deps
vlint init
vlint check --url http://localhost:3000/
```

If the destination is not already on `PATH`, the installer prints the exact
directory to add. The manual path remains available for environments that do
not execute downloaded scripts:

```sh
VERSION=v0.4.0
base="https://github.com/wh3at/vlint/releases/download/$VERSION"
archive="vlint-$VERSION-linux-x64.tar.gz"

curl -fsSLO "$base/$archive"
curl -fsSLO "$base/SHA256SUMS"
awk -v name="$archive" '$2 == name { print }' SHA256SUMS | sha256sum -c -
tar -xzf "$archive"
mkdir -p "$HOME/.local/bin"
install -m 0755 vlint "$HOME/.local/bin/vlint"
vlint --version
```

The archive contains exactly `vlint` (mode `0755`) and this `README.md`.

### What the checksum guarantees

`SHA256SUMS` confirms that each downloaded asset matches the bytes attached by
the release publisher. It is an integrity check, not a signature: the protected
GitHub tag and release remain the trust root.

## OS prerequisites

Choose one:

- Installing the `.deb` resolves the Ubuntu packages through APT.
- `vlint browser install --with-deps` explicitly installs the packages before
  installing the browser payload.
- For locked-down hosts, install the packages manually:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0t64 \
  libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
  libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2
```

The unflagged `vlint browser install` never modifies OS packages.

## Browser setup

Browser acquisition is always a separate, explicit operation. `vlint check`
never downloads, updates, or silently installs a browser.

```sh
vlint browser install               # pinned Chromium headless shell only
vlint browser install --force       # repair/reinstall browser payload
vlint browser install --with-deps   # Ubuntu libraries, then browser payload
```

`--force` and `--with-deps` may be combined. The browser revision is pinned to
the embedded Playwright version, and installation is idempotent. After upgrading
vlint, rerun `vlint browser install`.

`vlint setup` is the first-run convenience command:

```sh
vlint setup
```

It creates `vlint.config.json` only when absent, preserves an existing valid
configuration, and installs the browser payload. Invalid, unreadable, or
symlinked configurations fail rather than being replaced. If browser
installation fails after config creation, rerunning `vlint setup` safely
continues from the existing config.

## Command help

Run `vlint` with no arguments, or use `-h` / `--help`, to discover commands without reading configuration or starting browser work:

```sh
vlint
vlint --help
vlint check --help
vlint browser --help
vlint browser install --help
vlint init --help
vlint setup --help
```

Help is generated from the same command and option definitions used for parsing. Root, intermediate, and executable-command help writes to stdout and exits `0`. A recognized help flag takes precedence within its resolved command scope, including when neighboring arguments are invalid.

## Running checks

Every check requires a project-local `vlint.config.json`; run `vlint init` or
`vlint setup` first.

```sh
vlint check --url http://localhost:3000/  # every configured device, one URL
vlint check                               # every provider target × every device
vlint check --format json
vlint check --url http://localhost:3000/ --format json
```

- `--url` uses the configured ordered device list but does not resolve a target
  provider.
- Without `--url`, the config must contain a `static` or `command` provider.
- A config generated by `vlint init` intentionally contains devices and rules
  but no provider; it is immediately usable with `--url`.
- Targets are never skipped silently. Output remains target-major, device-minor.
- All target × device cases run concurrently with a fixed cap of 2 at a time,
  bounding CPU, memory, and target-server load. One case failing does not stop
  the remaining cases; the run is reported as `incomplete` (exit 2).

The caller starts the target application and prepares fixture data and any
authentication state. vlint does not start dev servers, generate fixtures, or
perform logins.

## Configuration

`vlint.config.json` is the only configuration source. It is read from the
current working directory, must be valid JSON, and must not exceed 8 MiB.
Generate the standard MacBook Air 13-inch and iPhone 17 profiles with:

```sh
vlint init
```

An expanded config with a static provider has this shape:

```jsonc
{
  "schemaVersion": 2,
  "devices": [
    {
      "name": "macbook-air-13-m5",
      "viewport": { "width": 1470, "height": 956 },
      "screen": { "width": 1470, "height": 956 },
      "deviceScaleFactor": 2,
      "isMobile": false,
      "hasTouch": false
    },
    {
      "name": "iphone-17",
      "viewport": { "width": 402, "height": 681 },
      "screen": { "width": 402, "height": 874 },
      "deviceScaleFactor": 3,
      "isMobile": true,
      "hasTouch": true,
      "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1"
    }
  ],
  "defaults": {
    "locale": "en-US",
    "timezoneId": "UTC",
    "timeoutMs": 30000,
    "readyCondition": { "selector": "#app", "state": "visible" }
  },
  "rules": [
    { "name": "tab-label-single-line", "type": "tab-label-single-line" },
    { "name": "page-horizontal-overflow", "type": "page-horizontal-overflow" }
  ],
  "provider": {
    "type": "static",
    "targets": [
      { "name": "settings", "url": "http://localhost:3000/settings" }
    ]
  }
}
```

### Fields

| Field | Description |
| --- | --- |
| `schemaVersion` | Must be `2`. |
| `devices` | Non-empty ordered device profiles with unique names. This is the only authority for viewport, screen, DPR, mobile mode, touch, and optional user agent. |
| `defaults` | Shared target defaults: `locale`, `timezoneId`, `timeoutMs` (`100`–`300000`), `readyCondition`, and `browserState`. |
| `rules` | Rule instances. Missing built-in types are injected in deterministic `tab-label-single-line`, configured rules, `page-horizontal-overflow` order. |
| `provider` | Optional `static` or `command` target provider. Required only for checks without `--url`. |

### Device profiles

Each profile has `name`, `viewport`, `screen`, `deviceScaleFactor`
(`0.1`–`10`), `isMobile`, and `hasTouch`. `userAgent` is optional; omitting it
keeps Chromium's default user agent. Device order determines result order inside
each target.

The iPhone profile is Chromium device emulation based on Playwright's descriptor;
it does not claim Safari or WebKit rendering fidelity.

### Rule instance (`tab-label-single-line`)

Inspects rendered tab labels and requires each label's rendered text to fit on a
single visual line.

| Field | Description |
| --- | --- |
| `name` | Unique rule name (≤ 1 KiB). |
| `type` | `tab-label-single-line`. |
| `additionalCandidateSelectors` | Extra CSS selectors added to `[role="tab"]`. |
| `excludeSelectors` | CSS selectors excluded from inspection. |
| `labelSelector` | Selector relative to each candidate; it must resolve to exactly one rendered element. |
| `minimumLabels` | Minimum matched candidates required for this instance. |
| `allowZeroLabels` | Allows a run that inspects zero labels. |

Tab targets may override `enabled`, `excludeSelectors`, and `minimumLabels` by
rule name. Device emulation is never overridden by targets.

### Rule instance (`page-horizontal-overflow`)

Detects unintended root-page horizontal scrolling and attributes it to rendered
light-DOM elements. A contained `overflow-x:auto|scroll` region is treated as an
intentional local boundary; if that boundary itself escapes the viewport, it is
reported.

| Field | Description |
| --- | --- |
| `name` | Unique rule name (≤ 1 KiB). |
| `type` | `page-horizontal-overflow`. |
| `enabled` | Project-level enablement; defaults to `true`. |
| `tolerancePx` | CSS-pixel tolerance from `0` through `100`; defaults to `1`. Overflow must be strictly greater. |

Overflow targets may override only `enabled` by rule name. The reported
violation contains `overflowPx`, border-box `geometry`, a verified unique
`locator`, and a fixed computed-CSS allowlist; it never includes HTML, ancestor
chains, or text content.

### Target providers

- **`static`** — ordered inline targets. Each target has `name`, `url`, target
  default fields, and optional `ruleOverrides`.
- **`command`** — runs a trusted executable without a shell and reads
  `{"targets":[...]}` from stdout. Fields: `executable`, optional `args`, and
  optional `timeoutMs` (default 30000).

A provider non-zero exit, timeout, oversized/invalid output, or zero targets is a
run failure.

### Migrating from schema version 1

Schema version 1 baked a single `1280×720` viewport into the binary and allowed
viewport/DPR overrides at the target and defaults level. Version 2 makes the
ordered `devices` array the sole viewport authority and requires
`"schemaVersion": 2`. No automatic migration is performed — update your config
explicitly:

1. **Back up** the existing config.
2. **Generate a v2 reference** with `vlint init` in a scratch directory, then
   copy the `devices` array (and optionally `rules`) into your config.
3. **Remove** `viewport` and `deviceScaleFactor` from `defaults` and from every
   target — they are no longer accepted. Viewport, screen, DPR, mobile, touch,
   and user agent now live exclusively in each device profile.
4. **Set** `"schemaVersion": 2` at the top level.
5. **Validate** non-destructively:
   ```sh
   vlint check --url http://localhost:3000/ --format json
   ```

Historical v1 consumers must first adopt the target/device `cases` shape described
under [Machine consumption](#machine-consumption-json-schema-v3).

### Migrating result consumers from v2 to v3

Configuration stays at schema version `2`; only the emitted result contract
changes. There are no compatibility aliases:

1. Require root result `"schemaVersion": 3`.
2. Rename rule/fact/finalization `labelsInspected` and summary
   `matchedElements` to `elementsInspected`.
3. Read each violation's `type` discriminator. Tab violations retain `text`,
   `lineCount`, `geometry`, and `locator`; overflow violations provide
   `overflowPx`, `geometry`, `locator`, and `computedStyle`.
4. Accept `page-horizontal-overflow` rule results and finalizations in addition
   to `tab-label-single-line`.

## Browser state (authentication)

For authenticated pages, supply a browser state file (Playwright storage state)
produced **by the caller**. vlint never logs in, stores credentials, handles MFA, or
solves CAPTCHAs.

- Set `browserState` in `defaults` or on a target to a path resolved relative to the
  config directory (regular file, symlink-resolved, ≤ 8 MiB).
- vlint reads it as a bounded regular file and applies it to the browser context.
- **Security:** vlint never copies raw state-file bytes, cookies, tokens, or parsed
  credential fields into terminal, JSON, or snapshot output. Treat the state file as a
  short-lived credential: keep it owner-only (`chmod 600`) and disposable. A permissive
  file mode is accepted at runtime, but an owner-only mode is recommended.

If an authentication prerequisite cannot be satisfied and the ready condition is not
reached, the run fails as `incomplete` (exit 2).

---

## Output: terminal vs JSON

`--format terminal` (default) prints a concise human-readable summary. Untrusted text
is passed through control/ANSI/OSC/bi-directional escape stripping and length caps;
URLs have their query values redacted and their fragments removed.

`--format json` prints a versioned JSON object (see
[Machine consumption](#machine-consumption-json-schema-v3)).

### Disclosure boundary

JSON output is treated as a **sensitive artifact**. It preserves configured URLs
exactly. Tab-label violations also preserve rendered label text exactly,
regardless of provenance; overflow violations intentionally omit text and HTML.
If an authenticated page renders sensitive tab text, that content can appear in
the JSON. Accordingly:

- Do not store or transmit JSON output from untrusted or authenticated pages in shared
  or long-lived locations.
- Prefer running checks against untrusted worktrees or pages in a credential-free,
  disposable container (see [Security notes](#security-notes)).

Provider stderr is drained only for cap/cleanup purposes; its content is never copied
into terminal, JSON, or failure messages — only the exit status, timeout/cap state, and
observed byte count are used.

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All targets inspected, no violations (`clean`). |
| `1` | All targets inspected with violations (`violations`), or the CLI rejected invalid command-line usage. |
| `2` | A valid command did not complete: config, target resolution, browser, navigation, authentication, font, ready-condition, rule-evaluation, setup, or install failure. Observed check violations are still included in JSON. |

CLI usage errors write to stderr and exit `1` without producing a check result. A completed check with violations instead writes its normal terminal or JSON result to stdout and also exits `1`.

---

## Machine consumption (JSON schema v3)

The root result `schemaVersion` is `3`. Configuration remains schema version `2`.
Results represent target × device audit cases explicitly and retain successful
cases when another case fails.

```jsonc
{
  "schemaVersion": 3,
  "status": "clean | violations | incomplete",
  "tool": { "name": "vlint", "version": "0.4.0" },
  "environment": {
    "platform": "linux",
    "arch": "x64",
    "browser": { "name": "chromium", "version": "<browser-version-or-null>" }
  },
  "summary": {
    "targets": { "resolved": 1 },
    "cases": {
      "resolved": 1,
      "complete": 1,
      "partial": 0,
      "failed": 0,
      "notExecuted": 0
    },
    "ruleEvaluations": {
      "clean": 2,
      "violations": 0,
      "failed": 0,
      "disabled": 0,
      "notExecuted": 0
    },
    "ruleFinalizations": { "passed": 2, "failed": 0, "notExecuted": 0 },
    "violations": 0,
    "elementsInspected": 1,
    "executionFailures": 0
  },
  "cases": [
    {
      "target": { "name": "adhoc", "url": "http://localhost:3000/" },
      "device": {
        "name": "macbook-air-13-m5",
        "viewport": { "width": 1470, "height": 956 },
        "screen": { "width": 1470, "height": 956 },
        "deviceScaleFactor": 2,
        "isMobile": false,
        "hasTouch": false,
        "userAgent": null
      },
      "locale": "en-US",
      "timezoneId": "UTC",
      "status": "complete",
      "rules": [
        {
          "name": "tab-label-single-line",
          "type": "tab-label-single-line",
          "status": "clean",
          "elementsInspected": 1,
          "violations": [],
          "failure": null
        },
        {
          "name": "page-horizontal-overflow",
          "type": "page-horizontal-overflow",
          "status": "clean",
          "elementsInspected": 0,
          "violations": [],
          "failure": null
        }
      ],
      "failures": []
    }
  ],
  "ruleFinalizations": [
    {
      "name": "tab-label-single-line",
      "status": "passed",
      "elementsInspected": 1,
      "failure": null
    },
    {
      "name": "page-horizontal-overflow",
      "status": "passed",
      "elementsInspected": 0,
      "failure": null
    }
  ],
  "failures": []
}
```

`cases` are ordered by target declaration first and configured device second.
Failures carry separate nullable `target`, `device`, and `rule` identities.
Adding optional fields is v3-compatible; renaming, removing, or changing a
field type requires another result `schemaVersion` bump. Timestamps are intentionally
omitted so stable inputs produce stable output.

## Browser cache hygiene

- vlint uses the **standard Playwright browser cache only**
  (`~/.cache/ms-playwright` under the default `HOME`). It does not accept alternate
  cache locations or download origins.
- `PLAYWRIGHT_BROWSERS_PATH` is **unsupported** and causes a `browser-cache-override-unsupported`
  failure on both `install` and `check`.
- On `install`, `PLAYWRIGHT_DOWNLOAD_HOST` and `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` are
  **unsupported** and cause a `browser-download-host-override-unsupported` failure.
- **Do not restore a browser cache produced by a different trust domain.** CI and
  release builds create a fresh, owner-only `HOME`/cache per run and never reuse a cache
  generated elsewhere.

---

## Consumer integration

vlint does not create or manage your CI, git hooks, or agent completion gates. Add the
command to your existing checks yourself. For example, in CI after your app is running:

```sh
vlint browser install        # once, in a network-enabled step
vlint check --format json    # in the step that runs your checks
```

Because `check` returns distinct exit codes, you can gate directly on the result:

```sh
vlint check --format json > vlint-result.json
status=$?
# 0 = clean, 1 = violations, 2 = incomplete
```

An AI agent can read `vlint-result.json`, locate the violating target and element
from its rule type, geometry, verified locator, and rule-specific diagnostics,
fix the layout, and re-run until exit `0`.

---

## Building from source

Requirements: Bun `1.3.14` and a frozen `bun.lock`.

```sh
bun install --frozen-lockfile
bun run build:linux-x64      # produces dist/vlint-linux-x64
./dist/vlint-linux-x64 --version
```

The production build target is `bun-linux-x64-baseline` (for broad x64 CPU
compatibility) and disables automatic `.env`/`bunfig.toml` loading so project-local
configuration cannot change the compiled binary's behavior. The build embeds the
Playwright library code and the vlint version (from `package.json`); it does **not**
embed a browser executable.

### Validating a release artifact

The one-command validator builds the production CLI and test fixture, stages the
versioned archive plus `SHA256SUMS`, and exercises the archive inside a clean Ubuntu
24.04 x64 guest with no runtime, package manager, or `node_modules`:

```sh
bun run release:validate    # requires Docker
```

The disposable guest verifies the checksum and archive shape, installs the pinned
browser, checks idempotent and forced repair paths, runs clean and violating checks
offline, and confirms that a missing browser never triggers a download. Temporary
staging and Docker state are removed after both success and failure.

For the original compiled-Playwright feasibility probe only, run
`bun run test:feasibility`.

---

## Security notes

- **Command Provider executes trusted arbitrary code** in the current environment. Only
  use it with reviewed, trusted configuration. Even the Static Provider executes target
  page JavaScript, so inspect untrusted worktrees or pages in a **credential-free,
  disposable container** — never pass credentials to a check of untrusted content.
- **Browser state is a credential.** Keep state files short-lived and owner-only.
- **JSON output may contain sensitive rendered content.** Do not persist JSON from
  authenticated or untrusted pages in shared locations.
- The release pipeline publishes only from a commit on the protected default branch
  whose required checks passed, after a clean-guest validation, under an approval-gated
  environment. The publish job holds the only write token, checks out no repository
  code, and runs no repository scripts; a separate permissions-empty job re-downloads
  the published asset anonymously and confirms the checksum.

---

## Limitations

- **Ubuntu 24.04 x64 only.** Other platforms are not supported by this release.
- vlint does **not** guarantee page/route discovery or full-site coverage — it inspects
  exactly the finite, declared target set.
- It does **not** do screenshot comparison, image understanding, or pixel-diff visual
  regression.
- It does **not** perform clicks, input, or scroll-based interaction scenarios.
- Pixel-identical results across different OSes, browser builds, fonts, or application
  data are **not** guaranteed; the same stable rendered state and rule configuration
  yield the same verdict.
