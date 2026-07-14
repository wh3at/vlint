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
- [Running checks](#running-checks)
- [Configuration](#configuration)
- [Browser state (authentication)](#browser-state-authentication)
- [Output: terminal vs JSON](#output-terminal-vs-json)
- [Exit codes](#exit-codes)
- [Machine consumption (JSON schema v1)](#machine-consumption-json-schema-v1)
- [Browser cache hygiene](#browser-cache-hygiene)
- [Consumer integration](#consumer-integration)
- [Building from source](#building-from-source)
- [Security notes](#security-notes)
- [Limitations](#limitations)

---

## Install

vlint is distributed from GitHub Releases as a versioned archive plus a SHA-256
checksum. No Node.js, Bun, npm, package manager, or `node_modules` is required on
the host.

```sh
VERSION=v0.1.0            # replace with the release tag you want
# Substitute <OWNER>/<REPO> with this repository's GitHub path.
base="https://github.com/<OWNER>/<REPO>/releases/download/$VERSION"

curl -fsSL "$base/vlint-$VERSION-linux-x64.tar.gz" -o vlint-$VERSION-linux-x64.tar.gz
curl -fsSL "$base/SHA256SUMS"                       -o SHA256SUMS

# Verify integrity (see note below on what the checksum guarantees).
sha256sum -c SHA256SUMS

tar -xzf vlint-$VERSION-linux-x64.tar.gz
install -m 0755 vlint /usr/local/bin/vlint    # or anywhere on PATH
vlint --version
```

The archive contains exactly two entries: `vlint` (mode `0755`) and this `README.md`.

### What the checksum guarantees

`SHA256SUMS` lets you confirm the bytes you downloaded match the bytes the release
publisher attached. It is an **integrity check, not a signature**: it is independent of
your trust in the download transport, but it does **not** replace trust in the GitHub
account, tag, and repository that published the release. Treat the GitHub Release and
its protected tag as the trust root, and the checksum as transport-level tamper
detection.

---

## OS prerequisites

vlint launches a Playwright-managed Chromium headless shell, which needs a set of
shared libraries on Ubuntu 24.04. Install them once:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0t64 \
  libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 \
  libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2
```

`vlint browser install` installs **only** the Playwright browser payload into the
standard Playwright cache. It does not install or modify OS packages.

---

## Browser setup

Browser acquisition is a **separate, explicit** step. `vlint check` never downloads,
updates, or silently installs a browser.

```sh
vlint browser install           # installs the pinned Chromium headless shell
vlint browser install --force   # repairs / reinstalls a damaged installation
```

- The browser revision is pinned to this vlint build through its embedded Playwright
  version; vlint does not manage browser builds itself.
- `install` is idempotent: re-running it on a healthy cache is a no-op.
- `--force` repairs or reinstalls a missing or damaged executable.
- After upgrading the `vlint` binary, re-run `vlint browser install` so the browser
  revision matches the new build.

If `vlint check` finds no usable browser, it fails fast with a typed
`browser-setup` failure and a reinstall hint (`browser-missing`), rather than
attempting an automatic download.

---

## Running checks

```sh
vlint check                              # inspect all declared targets (vlint.config.json)
vlint check --url http://localhost:3000/  # inspect a single ad-hoc URL
vlint check --format json                # machine-readable output
vlint check --url http://localhost:3000/ --format json
```

- With **no `--url`**, vlint resolves the finite target set from `vlint.config.json`
  (see [Configuration](#configuration)) and inspects every target in provider order.
  Targets are never skipped silently.
- With **`--url`**, vlint does **not** resolve a provider; it applies the common
  defaults and built-in rule to that single page. A `vlint.config.json` is not
  required for an ad-hoc URL check.

The caller is responsible for starting the target application, preparing fixture data
and any authentication state, and providing concrete URLs that reproduce a stable
rendered state. vlint does not start dev servers, generate fixtures, or perform logins.

---

## Configuration

Configuration is a single project-local file named `vlint.config.json`, read from the
current working directory. It is the **only** configuration source: there is no
arbitrary JavaScript, no global user config, and no parent-directory search. The file
must be valid JSON and no larger than 8 MiB.

```jsonc
{
  "schemaVersion": 1,
  "defaults": {
    "viewport": { "width": 1280, "height": 720 },
    "deviceScaleFactor": 1,
    "locale": "en-US",
    "timezoneId": "UTC",
    "timeoutMs": 30000,
    "readyCondition": { "selector": "#app", "state": "visible" }
  },
  "rules": [
    {
      "name": "tabs-single-line",
      "type": "tab-label-single-line",
      "additionalCandidateSelectors": [],
      "excludeSelectors": [],
      "labelSelector": null,
      "minimumLabels": 1,
      "allowZeroLabels": false
    }
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
| `schemaVersion` | Must be `1`. |
| `defaults` | Common defaults applied to every target: `viewport` (`width`/`height`), `deviceScaleFactor` (`0.1`–`10`), `locale`, `timezoneId`, `timeoutMs` (`100`–`300000`), `readyCondition`, `browserState`. |
| `rules` | Non-empty array of rule instances. The only supported `type` is `tab-label-single-line`. If omitted, a default instance is applied. |
| `provider` | Exactly one provider: `static` or `command`. |

### Rule instance (`tab-label-single-line`)

Inspects rendered tab labels and requires each label's rendered text to fit on a single
visual line.

| Field | Description |
| --- | --- |
| `name` | Unique rule name (≤ 1 KiB). |
| `type` | `tab-label-single-line`. |
| `additionalCandidateSelectors` | Extra CSS selectors added to the candidate set (default candidate is `[role="tab"]`). |
| `excludeSelectors` | CSS selectors excluded from inspection (e.g. intentionally multi-line tabs). |
| `labelSelector` | A selector **relative to each candidate** resolving to exactly one rendered element; zero or multiple matches is a rule-evaluation failure. Defaults to the whole candidate. |
| `minimumLabels` | Minimum matched candidates required for this instance (per-target or global). |
| `allowZeroLabels` | When `true`, a run that inspects zero labels is allowed instead of failing. |

Defaults merge in the order: built-in defaults → `defaults` → target fields. A target
may override per-rule behavior via `ruleOverrides` (disable a rule, add
`excludeSelectors`, set `minimumLabels`).

### Target providers

- **`static`** — declares an ordered array of targets inline. Each target has a `name`
  (≤ 1 KiB), a concrete `url`, and any `defaults` fields plus optional `ruleOverrides`.
- **`command`** — runs a trusted executable and reads a JSON `{"targets":[...]}`
  object from its standard output. Fields: `executable`, optional `args`, optional
  `timeoutMs` (default 30000). The provider runs with the invoking process environment
  and the config directory as its working directory, with no shell. A non-zero exit,
  timeout, invalid JSON, missing required field, or zero targets is a run failure.

---

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
[Machine consumption](#machine-consumption-json-schema-v1)).

### Disclosure boundary

JSON output is treated as a **sensitive artifact**. It preserves configured URLs and
all DOM-rendered text **exactly**, regardless of provenance, because locating a
violation requires the real rendered characters. If an authenticated page renders
sensitive content, that content can appear in the JSON. Accordingly:

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
| `1` | All targets inspected, one or more violations found (`violations`). |
| `2` | Run did not complete (`incomplete`): config, target resolution, browser, navigation, authentication, font, ready-condition, or rule-evaluation failure. Observed violations are still included in JSON. |

Invalid arguments also exit `2`.

---

## Machine consumption (JSON schema v1)

The JSON object has a fixed integer `schemaVersion` at the root (currently `1`). The
run status is one of `clean`, `violations`, or `incomplete`. The schema records target
and rule dispositions, machine-readable failure stages, and nested violations.

Top-level shape:

```jsonc
{
  "schemaVersion": 1,
  "status": "clean | violations | incomplete",
  "tool": { "name": "vlint", "version": "0.1.0" },
  "environment": {
    "platform": "linux",
    "arch": "x64",
    "browser": { "name": "chromium", "version": "<browser-version-or-null>" }
  },
  "summary": {
    "targets": { "resolved": 1, "complete": 1, "partial": 0, "failed": 0, "notExecuted": 0 },
    "ruleEvaluations": { "clean": 1, "violations": 0, "failed": 0, "disabled": 0, "notExecuted": 0 },
    "ruleFinalizations": { "passed": 1, "failed": 0, "notExecuted": 0 },
    "violations": 0,
    "matchedElements": 1,
    "executionFailures": 0
  },
  "targets": [ /* per-target name, url, viewport, status, rules[] with violations[] */ ],
  "ruleFinalizations": [ /* global zero-label invariant results */ ],
  "failure": null /* or { stage, code, message, target, rule } when incomplete */
}
```

Each violation carries the target name, URL, viewport, the rendered text, a DOM locator
that re-identifies the element at measurement time, the rule, the measured line count,
and the element box. The locator is unique at measurement time; its stability across
code changes is not guaranteed.

### Compatibility policy

Adding optional fields is v1-compatible. Renaming, removing, or changing the type of an
existing field requires bumping `schemaVersion`. Timestamps and success timing are
omitted so that the fields and ordering of a stable input are stable across runs.

---

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

An AI agent can read `vlint-result.json`, locate the violating target/element by name,
URL, rendered text, and locator, fix the layout, and re-run until exit `0`.

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
