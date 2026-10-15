# 3エンジン（Chromium / Firefox / WebKit）を再現可能に配布・実行するための事実整理

対象issue: [#45 3エンジンを再現可能に配布・実行できる条件は何か](https://github.com/wh3at/vlint/issues/45)

本書は**環境契約の下流判断（どのエンジンを、どのOSで、どう固定・導入するか）を可能にするための事実と未検証事項**の整理であり、方針判断そのものは行わない。

## 0. 調査方法と証拠クラス

| クラス | 意味 | 本書での表記 |
| --- | --- | --- |
| **A: リポジトリ事実** | `/home/wh3at/Work/vlint` の現行HEADのコード・スクリプト・CI定義を直接読んで確認した事実 | 「A:」（コード読解） |
| **B: 一次ドキュメント/一次ソース事実** | Playwright 1.61.1 のタグ付き一次ソース、`browsers.json`、公式ドキュメント、Bun公式ドキュメント、MCRのタグ一覧 | 「B:」 |
| **C: 推論** | A/Bから導いた推論。ソースが直接そう述べているわけではない | 「C:」（推論） |
| **D: 未検証** | 実機・実バイナリでの確認ができていないもの | §10 に列挙 |

補足（検証の限界）:
- 本調査ではブラウザのダウンロード・起動・3エンジン実行は行っていない。したがって「Firefox/WebKitでvlintが実際に動くか」はすべて未検証（§10）。
- ローカルにインストール済みの `node_modules/playwright-core/browsers.json` と、jsDelivr の `playwright-core@1.61.1` の同ファイルは**完全一致**することを確認済み（A∩B、相互検証）。以降のバージョン固定値は両者で一致。
- Playwright公式サイト `playwright.dev` の現行ドキュメントは**最新リリース（1.64.x）向け**である。vlint が固定する 1.61.1 の記述は `raw.githubusercontent.com/microsoft/playwright/v1.61.1/...` のタグ付きファイルを一次ソースとして使った（Dockerドキュメントは `docs/src/docker-js.md` ではなくサイト現行版のみ参照。§4 に注意書き）。

## 1. 現行vlintが固定しているもの（A:）

| 項目 | 現状 | 根拠 |
| --- | --- | --- |
| Playwright依存 | `playwright` 1.61.1（`dependencies`。devDependencyではない） | `package.json` |
| 管理対象ブラウザ名 | `chromium-headless-shell` **のみ**。定数 `MANAGED_BROWSER_NAME` で単一固定 | `src/browser/install.ts:50` |
| エンジン選択API | `import { chromium } from "playwright"` → `chromium.launch({ headless: true, executablePath })`。`firefox`/`webkit` は未使用 | `src/browser/lifecycle.ts:5`, `:188` |
| エンジンのリビジョン固定 | **ビルド時に `node_modules/playwright-core/browsers.json` と `package.json` の中身をJS文字列として埋め込む**（`browsers.json` を実行時に読まない） | `scripts/build.ts:4-5`, `:8-27`（`playwrightManifestPlugin`） |
| 実バージョン検証 | 実行ファイルに `--version` を実行し、標準出力の **`\d+\.\d+\.\d+\.\d+`（4要素）** が `browsers.json` の `browserVersion` と一致するか照合。不一致/非0終了/タイムアウトは `browser-incompatible` | `src/browser/install.ts:110`, `:219-243` |
| ブラウザ探索 | Playwright標準キャッシュのみ。`cacheRoot` は実行ファイルパスから3階層上、`chromium_headless_shell-*` / `chromium-*` ディレクトリを走査し `ready / missing / partial / revision-mismatch / not-executable` に分類 | `src/browser/install.ts:730-731`, `:763-871` |
| 環境変数の拒否 | `PLAYWRIGHT_BROWSERS_PATH` は install/check いずれでも**常に拒否**（`browser-cache-override-unsupported`）。install 時は `PLAYWRIGHT_DOWNLOAD_HOST` / `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` も拒否 | `src/browser/install.ts:245-270` |
| 依存ライブラリ導入 | `vlint browser install --with-deps` のみ。`registry.installDeps([chromium-headless-shell], false)` を `sudo` 経由の特権ワーカーで実行。`check` からは絶対に呼ばない | `src/browser/install.ts:162-200`, `:530-545` |
| `check` の入り口検証 | 実行前に管理ブラウザの存在＋実バージョンを再検証（ダウンロードはしない） | `src/browser/install.ts:639-680` |
| ビルド成果物 | `bun build --compile`, target `bun-linux-x64-baseline`, `external: ["chromium-bidi/*"]` | `scripts/build.ts:60-73` |
| OSゲート | **インストーラスクリプトのみ**が `/etc/os-release` を読み `ID=ubuntu` かつ `VERSION_ID=24.04` かつ x86_64 を要求。不一致は exit 2。バイナリ自身はOSを検証しない | `scripts/package-release.ts` `renderInstaller` |
| `.deb` の依存宣言 | `Depends:` は Chromium用のaptパッケージ一覧（＋`ca-certificates`, `fonts-liberation`） | `scripts/package-release.ts` `UBUNTU_BROWSER_DEPENDENCIES` |
| 検証済み実行環境 | CIはすべて `runs-on: ubuntu-24.04`。リリース検証は `FROM ubuntu@sha256:52df9b1e...`（noble）のコンテナ | `.github/workflows/ci.yml`, `tests/release/Containerfile:1` |
| 実行時並列度 | 1 runにつき**ブラウザプロセスは1個**を共有し、ケースは最大2並列（`workerCount = Math.min(2, cases.length)`） | `src/run/orchestrator.ts` |

**C（推論）**: 「エンジンのリビジョン固定」は配布バイナリのコンパイル時定数である。したがって固定エンジン集合を変えることは、設定変更ではなく**vlintの新ビルド**を意味する。3エンジン化した場合、1 runあたり3ブラウザプロセス（ブラウザタイプごとに1個）になる。

## 2. Playwright 1.61.1 が固定しているエンジン成果物（B:）

`playwright-core@1.61.1` の `browsers.json`（ローカル `node_modules` とnpm配布物で一致）:

| name | revision | installByDefault | browserVersion | title |
| --- | --- | --- | --- | --- |
| `chromium` | 1228 | true | 149.0.7827.55 | Chrome for Testing |
| `chromium-headless-shell` | 1228 | true | 149.0.7827.55 | Chrome Headless Shell |
| `chromium-tip-of-tree` | 1432 | false | 151.0.7886.0 | Chrome Canary for Testing |
| `chromium-tip-of-tree-headless-shell` | 1432 | false | 151.0.7886.0 | Chrome Canary Headless Shell |
| `firefox` | 1532 | true | **151.0** | Firefox |
| `firefox-beta` | 1526 | false | 152.0b1 | Firefox Beta |
| `webkit` | 2311 | true | **26.5** | WebKit |
| `ffmpeg` | 1011 | true | （なし） | — |
| `winldd` | 1007 | false | — | — |
| `android` | 1001 | false | — | — |

`webkit` には `revisionOverrides` がある: `mac14`/`mac14-arm64` → 2251、`debian11-x64`/`-arm64` → 2105、**`ubuntu20.04-x64`/`-arm64` → 2092**。

補足（A:）: vlintの compiled feasibility probe は固定revision `1228` を期待値として出力しており（`tests/feasibility/compiled-playwright.ts:45`, `:101`）、1.61.1の `chromium-headless-shell` 1228 と整合する。

### 2.1 ホストOSごとに配布物が違う（B:, `packages/playwright-core/src/server/registry/index.ts` @v1.61.1）

ダウンロードパス定義（`DOWNLOAD_PATHS`）から読み取れる事実:

- `webkit`: `builds/webkit/%s/webkit-ubuntu-24.04.zip`, `...-ubuntu-26.04.zip`, `...-debian-12.zip`, `...-debian-13.zip` など、**Ubuntu/Debianのリリースごとに別成果物**。`ubuntu20.04-*` は `webkit-ubuntu-20.04.zip`（固定リビジョン2092＝frozen）。
- `firefox`: `builds/firefox/%s/firefox-ubuntu-24.04.zip`, `firefox-debian-12.zip` など。**`ubuntu26.04-x64` は `firefox-ubuntu-24.04.zip` を再利用**。
- `chromium` / `chromium-headless-shell`: Chrome for Testing の `cftUrl(...)`（`builds/cft/<version>/linux64/...zip`）で、20.04以降は同じ linux64 成果物を再利用。
- 未対応ディストリの扱い: `isOfficiallySupportedPlatform` が false のとき `BEWARE: your OS is not officially supported by Playwright; downloading fallback build for <hostPlatform>.` を出す（コード上の事実）。フォールバック先は 2025-11 のコミット `bf6a60f chore: default to ubuntu 24.04 for unsupported distros (#38269)` で **`ubuntu24.04` に変更**された（`hostPlatform.ts` の1行差分）。
- `hasRevisionOverride` の成果物では `You are using a frozen <name> browser which does not receive updates anymore on <hostPlatform>.` を出す（＝`ubuntu20.04`/`debian11` 上の WebKit は frozen）。

**C（推論）**: 3エンジンの「バージョン固定」は `playwright` のバージョンだけでは閉じない。少なくともWebKitは**ホストOSリリースにも依存**し、非対応ディストリでは黙って別ビルドにフォールバックしうる。vlintの現行 `verifyActualBrowserVersion` は `--version` 出力と `browsers.json` の一致を見るため、フォールバックが起きれば `browser-incompatible` として**失敗側に倒れる**（＝偽cleanにはならない）。ただしfrozen WebKit（ubuntu20.04）では `browserVersion` が `undefined` になり（`readDescriptors` はoverride時に `browserVersion` を入れない）、`findManagedBrowser()` は `String(undefined)` = `"undefined"` を返す。**C（推論）**: この経路に乗ると現行のバージョン検証ロジックは成立しない。

## 3. Playwright 1.61.1 が宣言するLinuxサポート範囲（B:）

`docs/src/intro-js.md` @v1.61.1 の System requirements（タグ付き一次ソース）:

- Node.js: latest 22.x, 24.x or 26.x
- Windows 11+ / Windows Server 2019+ / WSL
- macOS 14 (Sonoma) 以降
- **Debian 12 / 13、Ubuntu 22.04 / 24.04 / 26.04（x86-64 または arm64）**

現行サイト（最新リリース向け）も同じ一覧で、`docs: add Ubuntu 26.04 and Node.js 26.x to system requirements (#41283)` で追加されたことが確認できる。1.61.1 のタグ付きドキュメントにも Ubuntu 26.04 が既に入っている（＝1.61.1時点で26.04対応は存在）。

musl/Alpine（B: `playwright.dev/docs/docker`）:
> Browser builds for Firefox and WebKit are built for the [glibc](...) library. Alpine Linux and other distributions that are based on the [musl](...) standard library are not supported.

**これはFirefox/WebKit固有の制約**である点が3エンジン化で重要（Chromiumの headless shell だけを使う現行構成では効いてこない）。

Bun側（B: `bun.com/docs/bundler/executables`）:
- `--compile` の対応ターゲット表で `bun-linux-x64` / `bun-linux-arm64` は **glibc**、`bun-linux-x64-musl` / `bun-linux-arm64-musl` は musl。
- x64では「BunはNehalem(SSE4.2)向け単一バイナリを出荷し実行時にAVX2/AVX-512を選択。`-baseline`/`-modern` は後方互換のため受理され、同じバイナリに解決される」。**C（推論）**: vlintの `bun-linux-x64-baseline` は `bun-linux-x64` と等価であり、CPU差の吸収はbaseline指定ではなくBun側のランタイム選択に依存する。

## 4. 依存ライブラリ: エンジンごとに必要なapt集合が違う（B:, `src/server/registry/nativeDeps.ts` @v1.61.1）

`ubuntu24.04-x64` エントリの実データ:

- `tools`（12）: `xvfb`, `fonts-noto-color-emoji`, `fonts-unifont`, `libfontconfig1`, `libfreetype6`, `xfonts-cyrillic`, `xfonts-scalable`, `fonts-liberation`, `fonts-ipafont-gothic`, `fonts-wqy-zenhei`, `fonts-tlwg-loma-otf`, `fonts-freefont-ttf`
- `chromium`（21）: `libasound2t64`, `libatk-bridge2.0-0t64`, `libatk1.0-0t64`, `libatspi2.0-0t64`, `libcairo2`, `libcups2t64`, `libdbus-1-3`, `libdrm2`, `libgbm1`, `libglib2.0-0t64`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libx11-6`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2`
- `firefox`（25）: 上記に加え `libavcodec60`, `libcairo-gobject2`, `libgdk-pixbuf-2.0-0`, `libgtk-3-0t64`, `libpangocairo-1.0-0`, `libx11-xcb1`, `libxcb-shm0`, `libxcursor1`, `libxi6`, `libxrender1`, `libfontconfig1`, `libfreetype6`（`libatk-bridge2.0-0t64`, `libatspi2.0-0t64`, `libcups2t64`, `libglib2.0-0t64` 系は含まれない）
- `webkit`（約52）: `gstreamer1.0-libav`, `gstreamer1.0-plugins-bad/base/good`, `libicu74`, `libenchant-2-2`, `libepoxy0`, `libevent-2.1-7t64`, `libflite1`, `libgbm1`, `libgles2`, `libgtk-4-1`, `libharfbuzz-icu0`, `libharfbuzz0b`, `libhyphen0`, `libjpeg-turbo8`, `liblcms2-2`, `libmanette-0.2-0`, `libopus0`, `libpng16-16t64`, `libsecret-1-0`, `libvpx9`, `libwayland-*`, `libwebp7`, `libwebpdemux2`, `libwoff1`, `libxml2`, `libxslt1.1`, `libx264-164`, `libavif16`, …（＋ `lib2package` に soname→パッケージ対応表）
- `ubuntu26.04-x64` も同ファイルに存在し、WebKitは `libicu78` などへ soname が変わる（＝**WebKitの依存はホストOSのリリースに追従**）。`ubuntu24.04-arm64` 等は x64 の定義を spread して流用。

リポジトリ現状との比較（A:）:
- vlintの `.deb` `Depends:` と README/CI/Containerfile の apt 一覧は、**Playwrightの `chromium`（21個）＋ `ca-certificates` + `fonts-liberation`** とほぼ一致する。Firefox/WebKitの依存（`libgtk-3-0t64`, `gstreamer*`, `libicu74`, `libenchant-2-2` 等）は**どこにも宣言されていない**。

**C（推論）**: 3エンジンを「vlintが明示的にprovisionする」場合、必要なapt集合はエンジン集合とホストOSリリースの積で増える。`registry.installDeps()` を実行ファイル名ごとに呼ぶ形に拡張すればPlaywright側の定義をそのまま使えるが、`.deb` の外部依存宣言・README・Containerfile・CIは別途整合が必要になる。

補足: `install-deps` はroot/sudoを要する（B: `playwright.dev/docs/browsers` の "Install system dependencies" 節、およびproxies節の "make sure to run the command as a root user"）。vlintは `sudo -v` → 特権スーパーバイザワーカーという独自経路で実装済み（A: `src/browser/install.ts:384-461`）。

## 5. コンテナ vs ネイティブ（B: + A:）

公式Dockerイメージ（`utils/docker/Dockerfile.noble` @v1.61.1）で確認した事実:
- `FROM ubuntu:noble`
- **`ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`** を設定し、`playwright-core install --with-deps` でブラウザを焼き込み、`chmod -R 777 /ms-playwright`
- `adduser pwuser`、`ARG DOCKER_IMAGE_NAME_TEMPLATE="mcr.microsoft.com/playwright:v%version%-noble"`
- MCRのタグ一覧（一次）に **`v1.61.1-noble`, `v1.61.1-noble-amd64`, `v1.61.1-jammy`, `v1.61.1-resolute` が存在**する

Dockerドキュメント（現行サイト、1.64.0で例示）の運用事実:
- `--ipc=host` を推奨（Chromiumが落ちるため）、`--init` 推奨、Chromium起動の奇妙なエラー時はローカル開発で `--cap-add=SYS_ADMIN`
- root実行ではChromiumサンドボックスが無効。非root＋seccomp profileで `clone/setns/unshare` を許可
- 「Playwright versionとDockerイメージのバージョンが一致しないとブラウザ実行ファイルを特定できない」
- イメージは信頼できないサイト閲覧には非推奨

**A×Bの衝突（重要）**: vlintは `PLAYWRIGHT_BROWSERS_PATH` を**常に拒否**する（§1）。公式Playwrightイメージは同変数を `/ms-playwright` に設定済み。したがって**公式イメージをそのままvlintの実行環境にすると、vlintは `browser-cache-override-unsupported` で即座に失敗する**（A: `src/browser/install.ts:250-256` の分岐、B: Dockerfileの `ENV` 行から導くC（推論）ではなく、両方の一次事実から直接言える）。回避するにはイメージ内で同変数をunsetし、通常キャッシュに別途インストールする（その場合、焼き込み済みブラウザは使われない）。

ネイティブ（Ubuntu 24.04ホスト）:
- 現行で検証済みなのは「Ubuntu 24.04 x64（GitHub Actions runner / `ubuntu@sha256:52df9b1e...` コンテナ）＋ chromium-headless-shell」のみ（A: CI/Containerfile/READMEの宣言）。
- リリース検証ゲストは `apt-get install -y --no-install-recommends` でChromium依存＋`sudo`＋`useradd` を行い、非rootユーザー `vlint` で実行する（A: `tests/release/Containerfile`）。

## 6. エンジンと製品（branded product）の区別（B:）

`playwright.dev/docs/browsers` の記述（現行サイト。1.61.1でも同等の節が存在）:

- **Chromium**: 「For Google Chrome, Microsoft Edge and other Chromium-based browsers, by default, Playwright uses open source Chromium builds. Since the Chromium project is ahead of the branded browsers, when the world is on Google Chrome N, Playwright already supports Chromium N+1」。brandedは `channel: 'chrome' | 'msedge' | ...` で別途指定（インストールも別）。
- **headless shell**: 「Playwright ships a regular Chromium build for headed operations and a separate chromium headless shell for headless mode」。`--only-shell` でshellのみ導入、`--no-shell` でshellをスキップ。
- **新headlessモード**: `channel: 'chromium'` で新しいheadlessに切り替わる。公式が「New Headlessは本物のChromeブラウザであり…より高精度なE2Eに向く」と述べ、Playwrightも「chromium headless shell とは挙動が異なる場合がある」と警告（＝**同一「Chromium」でも固定する成果物で挙動が変わる**）。
- **Firefox**: 「Playwright's Firefox version matches the recent Firefox Stable build. Playwright doesn't work with the branded version of Firefox since it relies on patches.」
- **WebKit**: 「Playwright's WebKit is derived from the latest WebKit main branch sources, often before these updates are incorporated into Apple Safari and other WebKit-based browsers.… Playwright doesn't work with the branded version of Safari since it relies on patches.… While running WebKit on Linux CI is usually the most affordable option, for the closest-to-Safari experience you should run WebKit on mac, for example if you do video playback.」またプラットフォーム依存機能（メディアコーデック等）はLinux/macOS/Windowsで大きく異なる。

**C（推論）**: ユーザー合意（「実Safari/iPhoneではなくChromium/Firefox/WebKitを対象」）は、Playwrightの上記記述と整合する。ただし「WebKitのLinuxビルド＝Linux上で最も安価な近似」であり、Safari実機の保証ではない点は、下流の環境契約の文言（保証範囲）に影響する。

## 7. コンパイル済みBun配布物とPlaywrightの統合（A: + B:）

- `bun build --compile` は「importされたファイルとパッケージをBunランタイムごと単一実行ファイルに同梱する」（B: Bunドキュメント）。ただし**外部化したパッケージは実行時に解決されない**という報告がある（B: oven-sh/bun issue #31632「`bun build --compile`: "external" packages not resolved externally」、#18749、#25038、#27530）。これはバグ報告（一次だが「報告」であって仕様記述ではない）。
- vlintが外部化しているのは `chromium-bidi/*` のみ（A: `scripts/build.ts:68`）。`playwright-core` の**公開パッケージ `package.json` は `dependencies` を一切持たない**（A: ローカル `node_modules/playwright-core/package.json`）。したがってビルド環境にも実行環境にも `chromium-bidi` は実在しない。
- `playwright-core` が読み込む `require("chromium-bidi/...")` は BiDi-over-CDP ブリッジ由来（B: microsoft/playwright issue #33031 のスタックトレース、および第三者コミットメッセージ）。**Firefoxの既定経路ではない**ことを一次ソースで確認した: v1.61.1 の `packages/playwright-core/src/server/firefox/firefox.ts` は `channel?.startsWith('moz-')` のときだけ `bidiFirefox` に委譲し、既定では `-juggler-pipe` を付けて起動する（`defaultArgs`）。
- Linux上の実行ファイル配置パターン（B: `registry/index.ts` @v1.61.1 の `EXECUTABLE_PATHS`）:
  - `chromium-headless-shell` / linux-x64 → `chrome-headless-shell-linux64/chrome-headless-shell`
  - `firefox` / linux-x64 → `firefox/firefox`
  - **`webkit` / linux-x64 → `pw_run.sh`**（macも `pw_run.sh`、winは `Playwright.exe`）
- vlintのビルドは `playwright-core` の `lib/**/*.js` 内の `require(...package.json)` / `require(...browsers.json)` を**埋め込みJSONに置換**している（A: `scripts/build.ts:8-27`）。これはBun issue #25038 が示す「`playwright-core/package.json` を実ファイルとして探しに行く」問題への対処。

**C（推論）**:
1. **バージョン検証の形状がChromium専用**。現行は `--version` 出力に `\d+\.\d+\.\d+\.\d+` を要求する（A）。`browsers.json` の `firefox.browserVersion` は `"151.0"`（3要素）であり、WebKitのLinux実行ファイルは `pw_run.sh`（バージョン問い合わせ用のCLIではない）。**「Firefox/WebKitでも同じ検証をそのまま使える」根拠は現時点で存在しない**（未検証、§10）。
2. Firefoxの既定起動経路はjugglerであり、`chromium-bidi` の遅延requireに依存しない可能性が高い。ただし**コンパイル済みバイナリでrequire評価がいつ起きるか**は未検証。WebKitのプロトコル経路も本調査では追い切っていない（`webkit.ts` には `bidi`/`juggler` の記述は見つからなかった）。§10参照。

## 8. 環境メタデータの現状（A:）

`vlint check --format json` の `environment` は**リテラル固定**（A: `src/run/orchestrator.ts` `completedResult`、`src/contracts/result.ts:88-92`）:

```json
"environment": { "platform": "linux", "arch": "x64", "browser": { "name": "chromium", "version": "<browser.version()>" } }
```

- `browser.name` はリテラル `"chromium"`、`platform`/`arch` もリテラル。**エンジン名を表現する余地が型として存在しない**。`version` は Playwright `browser.version()` の戻り値、起動失敗時は `null`。
- 記録されていない情報: ディストロ名/バージョン（`/etc/os-release`）、glibcバージョン、コンテナ/ネイティブの別、Playwrightバージョン、エンジンのrevision、実行ファイルパス、キャッシュ位置。
- `vlint browser status --format json` はより豊富（A: `src/commands/browser-status.ts`）: `status`, `requirements{ name, revision, browserVersion, executablePath, cacheRoot }`, `environment{ xdgCacheHome, playwrightBrowsersPath }`, `detectedRevisions[]`, `executablePresent`, `executableAccessible`。ただし単一ブラウザ前提。
- `RunStatus`/`CaseStatus` の構造もエンジン軸を持たない（case identityは target×device）。**C（推論）**: 3エンジン化は case の追加軸か実行の反復かを選ぶ必要があり、どちらでもJSON契約の変更になる。設定スキーマも `exactKeys(object, ["devices","provider","defaults","rules"])`（A: `src/config/schema.ts:518`）で、`device` の許容キーにもエンジンは無い（`:299-305`）。**C（推論）**: 既存configにエンジンを与えるには新フィールド追加が必要で、`exactKeys` 方式のため旧configは無変更で通る（後方互換）が、契約追加は不可避。

## 9. 既存ジオメトリルールとの互換性（A:）

現行ルールは全て**ページ内JS**として実行され、Node側は純関数（クラスタリング・ロケータ合成）という構成（A: `src/rules/tab-label-single-line.ts:9-17`）。

エンジン差が入力に効きうる箇所（A: コードから確認した依存API）:
- `Range` の矩形列（1行=1矩形を前提に、矩形の重なりと解決済み `line-height` の半分で行クラスタを形成: `sameLine`）。**行分割の矩形化は各エンジンのレイアウト実装に依存**する。
- `document.fonts.status !== "loaded"` をready境界の条件に使用（A: `src/browser/measurement.ts:39-58`）。
- `clip-path` は **`getComputedStyle` の文字列をvlint自身が解析**し、`inset()/xywh()/circle()/ellipse()/polygon()/path()/url(#id)` と `calc()`、`closest-side/farthest-side` をモデル化。`path()` の点内判定には `<canvas>` の2Dコンテキストを使用（A: `src/rules/table-cell-clipping.ts:21-119`）。READMEは「エンジンが還元できない式・読めない形状は空ではなく未モデルとして扱う」と明記。
- `[popover]`, `[role="tooltip"|"dialog"]`, `[role="img"]`, `aria-hidden`, `border-radius`、`overflow: hidden`（block/flex/grid）、ellipsis 等の判定はページ内で行う。

**C（推論）**: ルールのアルゴリズムはエンジン非依存だが、**入力（矩形・行分割・computed値）はエンジン実装差の影響を受ける**。「あるエンジンでしか `clip-path: xywh()` が計算値として観測されない」「行矩形の分割が異なる」といった差は、violation/clean の判定差になりうる。現時点で3エンジン間の判定一致を検証した証拠はない（**D: 未検証**）。既存の golden/integration/acceptance テストは `chromium-headless-shell` 前提で組まれている（A: `package.json` の `test:integration`/`test:acceptance`、CIのbrowser-testsジョブ）。

ADRとの関係（A: `docs/adr/`）: 0001/0004（ルール計測区間の境界検証）、0002（宣言された最小検査件数）、0003（URL生値の出力）はいずれもエンジン非依存の決定であり、3エンジン化そのものと衝突しない。**環境契約はこれらを弱めない形で追加される必要がある**（＝エンジンごとにURL/ready境界検証と件数保証を維持する必要がある）。

## 10. 未検証事項・未解決の問い（D:）

1. **Firefox / WebKit がvlintのコンパイル済みバイナリで実際に起動・検査できるか**。未検証（本調査でブラウザは導入していない）。CI/受け入れテストは `chromium-headless-shell` のみ。
2. **Firefox / WebKit の「実バージョン検証」方法**。`--version` が何を返すか（Firefoxは `Mozilla Firefox 151.0` 形式と推定されるが実測していない）、WebKitの `pw_run.sh` にバージョン相当の問い合わせが存在するか。→ 現行の4要素regexでは `"151.0"` に一致しない（C: 推論、ローカル `browsers.json` の値から）。
3. **コンパイル済みバイナリでの `chromium-bidi` 遅延requireの到達性**。Firefox既定（juggler）では到達しないと読めるが、モジュール読み込み時に評価されるかはBunのバンドル挙動依存で未検証。`moz-*` channelを使う方針を取る場合、追加の依存解決が必要になる可能性がある。
4. **WebKit on Linux の機能差がどのルールに影響するか**。特に `clip-path: xywh()` / `path()` の計算値サポート、`Range.getClientRects()` の行分割、`document.fonts.status`、`[popover]`。エンジン別の実測が必要。
5. **Playwright 1.61.1 の `hostPlatform` 判定の実装**（`/etc/os-release` のどのフィールドを見るか）。`packages/playwright-core/src/server/utils/hostPlatform.ts` は v1.61.1 のタグに存在せず（404）、配置場所を特定できなかった。コミット `bf6a60f` の差分と `registry/index.ts` の分岐からは「未対応ディストリ → ubuntu24.04 にフォールバック」までしか確認できていない。
6. **Ubuntu 20.04 のサポート終了時期**。現行リリースノートに "Ubuntu 20.04 is not supported anymore" の記述があるが、どのリリースで落ちたかは未確認（1.61.1の `browsers.json` には `ubuntu20.04` の WebKit revision override が残っている）。
7. **vlintの `PLAYWRIGHT_BROWSERS_PATH` 拒否が3エンジンでも妥当か**。公式イメージ（`/ms-playwright`）、`PLAYWRIGHT_BROWSERS_PATH=0`（hermetic install：`node_modules/playwright-core/.local-browsers`）はいずれも現行vlintでは使えない（B: browsersの "Hermetic install" 節、A: 拒否コード）。複数エンジンをキャッシュで共有・固定する戦略の選択肢を狭める。
8. **3エンジン化に伴う実行リソース**（1 runあたりブラウザプロセス数、メモリ、`--ipc=host` の必要性、`workerCount=2` との相互作用）は未計測。
9. **`chromium`（通常ビルド）と `chromium-headless-shell` のどちらを固定対象にするか**で挙動が違う（§6）。現行はshellのみ。

## 11. 下流の環境契約決定に効く含意（判断はしない）

決定に必要な入力として、次の事実が制約になる:

- **エンジン集合はprovision時の選択であり、コンパイル時定数**（§1）。`MANAGED_BROWSER_NAME` が単一の定数であること、`browsers.json` がビルド時に埋め込まれることが根拠。
- **`playwright` のバージョンを上げると全エンジンのリビジョンが同時に動く**（§2）。1.61.1 → 最新（現行ドキュメントは1.64.0基準）では `chromium` 1249 / `firefox` 1560 / `webkit` 2376 に変化し、mainの `browsers.json` からは `ubuntu20.04`/`debian11` の override が消えている。
- **ホストOSはエンジン固定の一部**（特にWebKit）（§2.1, §3）。「Ubuntu 24.04 x64」という現行の単一ゲートは、少なくともこの組み合わせでは整合する。
- **コンテナ採用は公式イメージそのままでは成立しない**（§5、`PLAYWRIGHT_BROWSERS_PATH` 拒否）。ネイティブ＋通常キャッシュ、あるいはイメージ派生＋変数unset＋再インストールのいずれかが必要。
- **依存導入はエンジン×OSの積で増える**（§4）。`.deb` `Depends:`、README、Containerfile、CIは現状Chromiumのみを宣言している。
- **環境メタデータは現状「linux/x64/chromium」しか表現できない**（§8）。3エンジンを再現可能に配布するには、エンジン識別・リビジョン・ホストOS識別の記録先が契約として必要になる。
- **ルール判定のエンジン間一致は未検証**（§9, §10-4）。「3エンジンで同じ判定になる」という前提を今は立てられない。

## ソース一覧

一次ソース（リポジトリ、現行HEAD）:
- `package.json`, `scripts/build.ts`, `scripts/package-release.ts`, `scripts/release-validate.ts`
- `src/browser/install.ts`, `src/browser/lifecycle.ts`, `src/browser/measurement.ts`
- `src/commands/check.ts`, `src/commands/browser-install.ts`, `src/commands/browser-status.ts`
- `src/config/schema.ts`, `src/contracts/config.ts`, `src/contracts/result.ts`, `src/run/orchestrator.ts`
- `src/rules/tab-label-single-line.ts`, `src/rules/table-cell-clipping.ts`
- `tests/feasibility/compiled-playwright.ts`, `tests/release/Containerfile`, `.github/workflows/ci.yml`
- `docs/adr/0001..0004`, `docs/operations/release.md`
- `node_modules/playwright-core/browsers.json`（1.61.1相当）, `node_modules/playwright-core/package.json`

一次ソース（外部）:
- Playwright 1.61.1 タグ付きソース: `browsers.json`, `docs/src/intro-js.md`, `packages/playwright-core/src/server/registry/index.ts`, `.../registry/nativeDeps.ts`, `.../server/firefox/firefox.ts`, `.../server/webkit/webkit.ts`, `utils/docker/Dockerfile.noble`（`https://raw.githubusercontent.com/microsoft/playwright/v1.61.1/...`）
- 公式ドキュメント: [Browsers](https://playwright.dev/docs/browsers), [Installation](https://playwright.dev/docs/intro), [Docker](https://playwright.dev/docs/docker)
- 公式コミット/PR: [`bf6a60f` unsupported distros → ubuntu 24.04](https://github.com/microsoft/playwright/commit/bf6a60fd92c8c3b4afa08837aa8bbcd44f50c95e), [`#41025` Ubuntu 26.04 support](https://github.com/microsoft/playwright/pull/41025), [`a2905f5` system requirements docs](https://github.com/microsoft/playwright/commit/a2905f5121121ab7c4254eadaefbb1c8f69985ef)
- MCRタグ一覧: `https://mcr.microsoft.com/v2/playwright/tags/list`（`v1.61.1-noble` 等の存在確認）
- Bun: [Single-file executable](https://bun.com/docs/bundler/executables)
- Bun issue（バグ報告であり仕様記述ではない）: [#31632](https://github.com/oven-sh/bun/issues/31632), [#18749](https://github.com/oven-sh/bun/issues/18749), [#25038](https://github.com/oven-sh/bun/issues/25038), [#27530](https://github.com/oven-sh/bun/issues/27530)
- Playwright issue（同上）: [#33031 chromium-bidi require](https://github.com/microsoft/playwright/issues/33031), [#27139 bun compatibility](https://github.com/microsoft/playwright/issues/27139), [#38121 add bun support](https://github.com/microsoft/playwright/issues/38121)

## 残る問い（次段で潰すべきもの）

1. Firefox/WebKitの実行ファイルから**バージョンを機械可読に取得する方法**があるか（`--version`、プロトコル応答、配布メタデータ）。
2. コンパイル済みBunバイナリで**Firefox/WebKitの起動が成立するか**（最小再現）。
3. 3エンジンで**同一フィクスチャの判定が一致するか**（少なくとも `clip-path` 系と行分割系）。
4. 公式Playwrightイメージを使う場合の**変数unset＋再インストール手順**が成立するか、それともネイティブ前提を維持するか。
5. 環境メタデータとして何を契約に載せるか（Playwrightバージョン、エンジン名、revision、ホストOS識別、キャッシュ位置、glibc）。
