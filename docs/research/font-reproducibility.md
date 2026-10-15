# フォントの固定・供給・検証の限界（調査メモ）

対象: [issue #44](https://github.com/wh3at/vlint/issues/44)「フォントの固定と使用確認はどこまで保証できるか」。
親: [issue #43](https://github.com/wh3at/vlint/issues/43)（検査環境の再現性と複数ブラウザー対応の仕様）。
下流: [issue #46](https://github.com/wh3at/vlint/issues/46)（フォントの宣言と必須条件の成立）。

- **製品方針は決めない。** 本メモは事実・制約・未確認事項のみを提示し、トレードオフは下流の判断に委ねる。
- 用語は `CONTEXT.md`（対象ページ / ready状態 / ルール計測区間）に従う。
- **本調査は読み取りのみ。** 実行環境に shell がなく、ブラウザーを起動した実測は行っていない。したがって「テスト済み」の事実は**リポジトリ内コードの直接読解**に限られ、ブラウザー挙動は**文書化された事実**（仕様・一次ドキュメント）または**仮説（未検証）**である。各項目に区分を明記する。

## 証拠の区分

- **[直接]** リポジトリ内のコード・フィクスチャ、または一次仕様・一次ドキュメントに書かれている内容の引用。
- **[解釈]** 直接証拠から本調査者が導いた推論（出典がそう述べているわけではない）。
- **[仮説]** 未検証。ローカル実験が必要。

---

## 1. 現行 vlint がフォントについて実際に確認していること **[直接]**

`src/browser/readiness.ts` の `waitForFonts()` は次の2段階のみ:

1. `page.waitForFunction(() => globalThis.document.fonts.status === "loaded")` を deadline 内で待つ。TimeoutError は `font-timeout`（`stage: "web-font"`）。
2. その後 `page.evaluate` で `document.fonts.forEach(face => face.status === "error")` を数え、1件以上なら `font-load-failed`。

この実装から確定できる範囲:

- 確認対象は **`document.fonts`（FontFaceSet）に登録された FontFace だけ**。システムフォントは FontFaceSet のエントリにならないため、原理的に確認対象外 **[直接（仕様）+ 解釈]**。
- 確認しているのは「読み込みが完了したか」「読み込みに失敗した面があるか」であり、「どのフォントが描画に使われたか」ではない **[解釈]**。
- 失敗コードは `web-font` stage の `font-load-failed` / `font-timeout` のみ（`docs/plans/2026-07-14-001-feat-vlint-plan.md` の FailureStage/FailureCode 表）。宣言フォントと実使用フォントの不一致を表すコードは存在しない **[直接]**。

設定側にフォント宣言は無い。`src/contracts/config.ts` の `TargetDefaults` は `locale` / `timezoneId` / `timeoutMs` / `browserState` / `readyCondition`（`selector` + `state`）のみ **[直接]**。

計画上の前提（`docs/plans/2026-07-14-001-feat-vlint-plan.md`）:

- A4「対象application: 呼び出し側が起動し、固定data、権限、**font**、認証済みstateを含む再現可能なpageを提供する」→ 現行計画ではフォント供給はアプリ側の責任 **[直接]**。
- Risk 表「Fontとlayout fixtureのenvironment差 | false positiveまたはflaky verdict | local font、fixed viewport/context、network-free fixture、repeatability gate」 **[直接]**。
- Implementation Constraints「page、font、fixture trafficはrepository内fixtureだけを使い、install後のcheckはnetwork-disabled guestで再現する」 **[直接]**。

フィクスチャ **[直接]**:

- `tests/fixtures/app/pages/font-ok.html`（`/font.ttf` を `@font-face`）、`font-error.html`（404 を指す → 面が error になる経路）、`font-hang.html`（応答しない `/hang` → timeout 経路）。
- `tests/fixtures/app/fonts/test-regular.ttf`（50,360 バイト）。**このファイルの出自・ライセンス表示はリポジトリ内に見当たらない**（未解決事項、§6）。
- **日本語・混在スクリプト・システムフォント・per-glyph フォールバックのフィクスチャは存在しない**（`tests/fixtures/app/pages/` の一覧および `readiness.test.ts` の対象から）。

---

## 2. CSS Font Loading API で確認できること / できないこと **[直接]**

一次仕様: CSS Font Loading Module Level 3（[drafts.csswg.org](https://drafts.csswg.org/css-font-loading/)）、CSS Fonts Module Level 4（[drafts.csswg.org/css-fonts-4](https://drafts.csswg.org/css-fonts-4/)）。

1. `FontFaceSet.status` は `"loading"` / `"loaded"` の2値。`[[LoadingFonts]]` が空になった時に "switch the FontFaceSet to loaded" が走る。**新しい読み込みが始まれば再び "loading" に戻る**（"Set the status attribute of font face set to 'loading'"）。→ `status === "loaded"` は**ある瞬間のスナップショット**であり、以降の遅延読み込みを排除しない **[直接+解釈]**。
2. FontFaceSet に入るのは CSS `@font-face` 連動オブジェクトとスクリプトで追加した FontFace。`check()` は「Find the matching font faces ... **including system fonts**」で、システムフォントまたは存在しないフォントだけを指定した場合は `true` を返す（MDN の例: `document.fonts.check("12px Courier")` → true、"i-dont-exist" → true）。→ `check()` は「追加読み込みが必要か」の述語で、**どのフォントが使われるかの答えではない** **[直接]**。
3. `check(font, text)` の `text` は unicode-range によるフィルタであり、MDN は明示的に "This **does not check for individual glyph coverage**" と書く **[直接]**。
4. **宣言 ≠ 読み込み**: CSS Fonts 4「user agents **must only download those fonts that are referred to within the style rules applicable to a given page**. User agents that download all fonts defined in @font-face rules without considering whether those fonts are in fact used within a page are considered non-conformant.」→ 宣言された `@font-face` でも、使われなければ取得されず、`status` は `"unloaded"` のまま **[直接]**。
5. **読み込み ≠ 使用**: MDN Document.fonts は「The set of **used** fonts can be different from the set of **declared** fonts, e.g., if optional fonts (i.e., fonts declared via `font-display: optional`) were not able to load in time.」と述べる **[直接]**。
6. **グリフ欠落は失敗にならない**: CSS Fonts 4 の照合手順 step 8「If a particular character cannot be displayed using any font, the user agent **should** indicate by some means that a character is not being displayed, displaying either a symbolic representation of the missing glyph (e.g. using a **Last Resort Font**) or using the missing character glyph from a default font.」。step 7 の installed font fallback は「The result of this procedure **can vary across user agents**」 **[直接]**。→ CSS には「代替が起きたら失敗にする」機構が無く、検出は観測側の仕事になる **[解釈]**。
7. **標準化の現状**: W3C csswg-drafts [#14379](https://github.com/w3c/csswg-drafts/issues/14379)（open、2026-08-24 作成、label `css-font-loading-3` / `i18n-tracker`）は「the web platform currently does not seem to expose an API for asking "**which font painted these glyphs**"」「`getComputedStyle(element).fontFamily` does not solve it, since it gives you the computed CSS family list, not the font actually selected」と明記し、「Chrome DevTools has **Elements → Computed → Rendered Fonts**, and Firefox's Inspector has a **Fonts** panel which reports "Fonts used", so browser engines already have the information we want, but **it isn't exposed through a Web API**」と述べる **[直接]**。
8. 同 issue が示す代替テクニック（**存在確認**であって使用確認ではない）: `@font-face { font-family: "__Exact_Raleway"; src: local("Raleway"); font-weight: 400; font-style: normal; }` + `font-synthesis: none` を宣言し、`document.fonts.load()` の結果の `status === "loaded"` でローカルフォントの有無を推定する **[直接]**。

---

## 3. 「実際に使われたフォント」をエンジンから取る手段

### 3.1 Chromium: CDP `CSS.getPlatformFontsForNode` **[直接]**

一次ソース: devtools-protocol の PDL（[`pdl/domains/CSS.pdl`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/CSS.pdl)）。

- `experimental domain CSS depends on DOM depends on Page`。
- `command getPlatformFontsForNode` — 「Requests information about platform fonts which we used to render **child TextNodes** in the given node」、引数 `DOM.NodeId nodeId`、戻り値 `array of PlatformFontUsage fonts`。
- `PlatformFontUsage` = `familyName`（platform が報告するファミリ名）/ `postScriptName` / `isCustomFont`（ダウンロードフォントかローカル解決か）/ `glyphCount`（そのフォントで描画されたグリフ数）。
- **[解釈]** 1ノードに対して複数エントリが返れば、そのノード内でフォントフォールバックが起きたと読める。ただし粒度は**ノード単位**であり、TextNode ごと・文字ごとの内訳が得られるかは未確認（§9）。

### 3.2 Playwright 経由での到達性 **[直接]**

- Playwright 公式ドキュメント: `browserContext.newCDPSession()` に「**CDP sessions are only supported on Chromium-based browsers.**」と記載（[BrowserContext](https://playwright.dev/docs/api/class-browsercontext)）。
- Playwright [#20699](https://github.com/microsoft/playwright/issues/20699) で CDP セッション生成時の例外「CDP session is only available in Chromium」が報告され、maintainer は「CDP stands for "Chrome DevTools Protocol", so I don't think we should be expecting it implemented in "Firefox", ever.」と回答（2023-02-07） **[直接]**。同スレッドで「Firefox は CDP のサブセットを実装している」というコメントがあるが、その URL（firefox-source-docs の remote/cdp）は本調査で本文未確認 **[仮説]**。
- **[解釈]** vlint は Playwright を実行基盤にしているため、**per-font / per-glyph の実使用情報は Chromium 系でのみ取得可能**。Firefox / WebKit では同じ情報を Playwright API からは取れない。

### 3.3 Firefox / WebKit の engine 側能力 **[直接（ソース読解）]**

- Firefox: Inspector の「Fonts」パネルが使用フォントを表示する（[Firefox Source Docs: Edit fonts](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/edit_fonts/)）。remotable 化は [Bug 886041](https://bugzilla.mozilla.org/show_bug.cgi?id=886041) の主題。ただし Playwright は Firefox の DevTools protocol を露出しないため、vlint からは到達できない **[直接+解釈]**。
- WebKit: Web Inspector protocol の CSS domain に `getFontDataForNode` があり、「Returns the **primary font** of the computed font cascade for a DOM node identified by `nodeId`」、`Font` オブジェクト（`displayName`、`variationAxes`、`synthesizedBold`、`synthesizedOblique`）を返す。`getSupportedSystemFontFamilyNames` もある（[WebKit CSS.json](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/CSS.json)）。
  - **[解釈]** 「primary font」のみで `glyphCount` に相当する per-glyph 情報は無い。さらに Playwright は WebKit の Inspector protocol を公開していないため、vlint からはやはり到達できない。
- **[仮説]** Firefox / WebKit で per-glyph を取るには、Playwright を離れて各エンジンの開発者プロトコルを直接叩く必要があり、これは現行の配布・install 契約とは別の依存になる。

### 3.4 エンジン非依存の近似手段 **[直接（一般技法）+ 解釈]**

- canvas `measureText()` の幅比較によるフォント検出（候補フォントと既知フォールバックで同じ文字列を描き、幅が一致すれば候補は無い）。幅が偶然一致する組み合わせでは偽陰性が出る **[解釈]**。
- Local Font Access API（WICG [仕様](https://wicg.github.io/local-font-access/)／MDN `Window.queryLocalFonts()`）は「利用者がローカルフォント集合の列挙を許可する」ための仕様として存在する。対応エンジン・権限フロー・自動化からの可否は本調査では未確認 **[仮説]**。

---

## 4. Linux でのフォント解決と「固定」

一次ソース: fontconfig の [fonts-conf(5) 相当ドキュメント](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user)。

1. **解決は必須で成功する**: 「Fontconfig performs matching by measuring the distance from a provided pattern to all of the available fonts in the system. The closest matching font is selected. **This ensures that a font will always be returned, but doesn't ensure that it is anything like the requested pattern.**」→ 要求ファミリが存在しなくても**必ず何かが返る**（＝静かな代替） **[直接]**。
2. **プロセス単位で解決を差し替えられる**: `FONTCONFIG_FILE`（既定の設定ファイルを上書き）、`FONTCONFIG_PATH`（既定の設定ディレクトリを上書き）、`FONTCONFIG_SYSROOT`、`FC_LANG`、`FC_DEBUG`。設定側では `<dir>`（`prefix="xdg"` で `XDG_DATA_HOME` を前置）、`<cachedir>`（`XDG_CACHE_HOME`）、`<reset-dirs/>`、`rejectfont` / `acceptfont`、`<alias>` による generic family の割り当てが可能 **[直接]**。
3. 3エンジンの Linux 実装は fontconfig 系: Chromium は `third_party/fontconfig` を同梱（[chromium roll commit](https://github.com/chromium/chromium/commit/a8ea803fa87af09341cc6b794e7c6891388093ca)）、Firefox は fontconfig platform fontlist（[Bug 1180560](https://bugzilla.mozilla.org/show_bug.cgi?id=1180560)）、WebKitGTK は Pango→fontconfig **[直接（該当ソース・バグの存在）+ 解釈]**。
4. **逆方向の証拠**: Chromium の旧 headless 実装には「The approach below ignores any ... entries in fonts.conf. **This is deliberate.**」（[`headless/public/util/fontconfig.cc` @62.0.3178.1](https://chromium.googlesource.com/chromium/src.git/+/62.0.3178.1/headless/public/util/fontconfig.cc)）という記述がある。また Firefox には fontconfig 設定が無視される既知バグが複数ある（例: [Bug 1244212](https://bugzilla.mozilla.org/show_bug.cgi?id=1244212)、[Bug 1173260](https://bugzilla.mozilla.org/show_bug.cgi?id=1173260)） **[直接]**。
   - → **「`FONTCONFIG_FILE` を設定すれば3エンジンで解決が固定される」とは本調査では言えない**。各エンジンが環境変数を尊重するかは未検証 **[仮説]**。Playwright 1.57 以降の headless は `chrome-headless-shell` を使う（[release notes](https://playwright.dev/docs/release-notes): 「Playwright now runs on Chrome for Testing builds rather than Chromium. Headed mode uses `chrome`; headless mode uses `chrome-headless-shell`.」）ため、上記の旧 headless の記述をそのまま現行に当てることもできない **[解釈]**。

### 4.1 Playwright が「サポート環境」で用意するフォント集合 **[直接]**

`npx playwright install-deps` が入れるパッケージは `packages/playwright-core/src/server/registry/nativeDeps.ts` にハードコードされている（[出典](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/nativeDeps.ts)）。`ubuntu24.04-x64` の `tools` は以下（逐語）:

```
'xvfb', 'fonts-noto-color-emoji', 'fonts-unifont', 'libfontconfig1', 'libfreetype6',
'xfonts-cyrillic', 'xfonts-scalable', 'fonts-liberation', 'fonts-ipafont-gothic',
'fonts-wqy-zenhei', 'fonts-tlwg-loma-otf', 'fonts-freefont-ttf'
```

- 日本語は `fonts-ipafont-gothic`、CJK 漢字は中国語フォント `fonts-wqy-zenhei` が関与し得る。**Noto Sans CJK / Noto Sans JP は含まれない** **[直接]**。
- ただし実行時に入っているのは **これらのパッケージのフォントだけではなく**、base image（`ubuntu:noble`）が持つフォントやユーザー追加分も fontconfig 経由で解決対象になる。集合の完全な固定にはならない **[解釈]**。
- 公式 Dockerfile は `apt-get install` に `fonts-*` を明示せず、`playwright-core install-deps` に委ねている（[`Dockerfile.noble`](https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.noble)） **[直接]**。
- **[解釈]** したがって「Playwright のサポート環境」と「vlint の実行環境」は一致し得るが、フォント集合は OS パッケージのバージョンに依存し、vlint は現行契約上それを記録も検証もしていない。

---

## 5. 日本語・混在スクリプトで「確認」が破れるパターン

| # | 状況 | 何が起きるか | 検出可能性 |
|---|---|---|---|
| 1 | 和文がシステムフォント任せ（`@font-face` 無し / 一部のみ） | FontFaceSet に現れないので vlint は何も観測できない | 不可（現行 API） **[直接+解釈]** |
| 2 | 部分被覆による per-glyph フォールバック（漢字・記号・絵文字） | フォントは `loaded` でも意図した書体で描かれていない | 不可（ページ側 API）。Chromium CDP では候補になり得る **[仮説]** |
| 3 | `unicode-range` による subset 分割（Google Fonts の CJK 分割配信。fontsource のメタデータは woff2 を subset ごとに分割と説明: [出典](https://github.com/fontsource/google-font-metadata/)） | 使った subset だけ取得される。取得しなかった subset の被覆は検証されない | 部分的（未取得であることは見えるが「未取得＝違反」ではない） **[解釈]** |
| 4 | `font-display: optional` / `swap` | 「読み込み完了」と「使用」がずれる（MDN: used fonts ≠ declared fonts） | 「使われたか」は現行 API では不可 **[直接]** |
| 5 | 計測中/後の遅延読み込み（動的挿入・スクロール後の遅延 CSS） | `status` は loaded に戻ってから再び loading になる可能性 | スナップショット問題として残る **[仮説]** |
| 6 | 環境間のフォント集合差 | 同じ宣言でも計測幅が変わる（false positive / flaky） | 環境情報を記録しない限り説明不能 **[解釈]** |
| 7 | 日英混在（ラテンは Web フォント、和文はシステム） | 後者の使用フォントは確認不能。混在テストの代表例 | 不可 **[解釈]** |

**確認失敗（条件不成立なのか、確認不能なのか、対象外なのか）の区別は、現行の failure 契約（`web-font` stage の2コードのみ）では表現できない** **[解釈]**。これは #46 の判断材料であり、本メモでは決めない。

---

## 6. フォントの再配布ライセンス（自前同梱を選ぶ場合の制約） **[直接]**

- **SIL OFL 1.1**（[全文](https://openfontlicense.org/documents/OFL.txt)）:
  - 条件1「Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.」
  - 条件2「Original or Modified Versions of the Font Software **may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license**.」（stand-alone text file / human-readable header / machine-readable metadata のいずれでも可、ただし user が容易に閲覧できること）
  - 条件3 Reserved Font Name は Modified Version で使用不可（明示の書面許可がある場合を除く）。条件5 派生物も OFL で配布。文書（フォントを使って作った成果物）には及ばない。
- **IPA Font License v1.0**（`fonts-ipafont-gothic` が該当）第3条2項（[一次（日本語）](https://moji.or.jp/ipafont/license/)、[OSI 掲載](https://opensource.org/license/ipa)）: 無改変再配布には「(1) 許諾プログラムの名称を変更してはなりません。(2) 許諾プログラムに加工その他の改変を加えてはなりません。(3) 本契約の写しを許諾プログラムに添付しなければなりません。」派生プログラムには第3条1項の追加条件（差分提供、名称の非同一、同一ライセンスでの許諾など）。
- **[解釈]** Playwright のサポート環境フォント集合（`fonts-ipafont-gothic`（IPA ライセンス）、OFL 系、その他）をそのまま vlint の配布物に同梱する場合、**複数ライセンス文の添付と名称・改変制限の順守**が必要になる。一方、apt 等の OS パッケージとして供給する場合は vlint 自身が再配布者にならない。
- **[仮説]** 各パッケージの実ライセンス（Debian `debian/copyright`）は本調査で本文取得できなかった（`sources.debian.org` の raw 取得が失敗）。`fonts-freefont-ttf` 等が OFL 以外（フォント例外付き GPL 等）である可能性の確認は未完了。
- **[直接]** リポジトリの `tests/fixtures/app/fonts/test-regular.ttf` にはライセンス表示が無い。配布物に含まれる以上、fixture フォントのライセンス管理は既に未解決事項。

---

## 7. 現行手段で「宣言条件の不成立」を検出できる範囲（まとめ）

| 宣言・条件 | Chromium | Firefox | WebKit | 根拠 |
|---|---|---|---|---|
| `@font-face` の取得失敗（面が `error`） | 可 | 可 | 可 | 現行実装 `readiness.ts` + `font-error.html` **[直接]** |
| `@font-face` の読み込みが deadline 内に終わらない | 可 | 可 | 可 | 現行実装 + `font-hang.html` **[直接]** |
| 宣言したが一度も取得されない（未使用 / unicode-range 外） | 「未取得」は見える | 同左 | 同左 | 仕様上、未使用フォントを落とすのは適合挙動 **[直接]**（＝違反判定には使えない） |
| 宣言フォントが実際に描画に使われたか | 候補あり（CDP `getPlatformFontsForNode`） | 不可（Playwright 経由） | 不可（Playwright 経由） | §3 **[直接+仮説]** |
| システムフォントのどれが使われたか | 候補あり（同上） | 不可 | 不可 | §3 **[直接]** |
| per-glyph の内訳（TextNode 単位・文字単位） | 未確認（ノード単位のみ確認） | 不可 | 不可 | §3.1 **[仮説]** |
| グリフ欠落（tofu）そのもの | 不可 | 不可 | 不可 | CSS は失敗にしない（Last Resort Font） **[直接]** |
| 環境が同じフォント集合だったか | 不可（現行契約に記録が無い） | 不可 | 不可 | §1, §4.1 **[直接]** |

---

## 8. 環境の準備・固定に使える道具（事実のみ）

- **供給**: apt 等でフォントパッケージを入れる（`playwright install-deps` の集合が事実上の基準）。追加パッケージのバージョン固定は OS 側の管理になる。
- **解決の固定（候補）**: `FONTCONFIG_FILE` / `FONTCONFIG_PATH` / `FONTCONFIG_SYSROOT`、`<dir>` / `<reset-dirs/>` / `rejectfont`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`（fontconfig ドキュメント記載）。**各エンジンが尊重するかは未検証** **[仮説]**。
- **ページ側の自己完結**: 対象ページが fixture 内でフォントを供給する（現行計画 A4 と Implementation Constraints の「network-free」に一致）。Web フォントを `@font-face` で自己ホストすれば、少なくとも**その面の取得成否**は検出可能。
- **列挙**: Local Font Access API（Chromium 実装、WICG 仕様）。自動化時の権限処理は未確認 **[仮説]**。

---

## 9. 未確認事項（ローカル検証が必要）

1. `chrome-headless-shell`（Chromium 149 系、Playwright 1.61）が `FONTCONFIG_FILE` / `FONTCONFIG_PATH` を尊重するか。
2. Firefox / WebKit (Playwright ビルド) が同環境変数を尊重するか。
3. `ubuntu:24.04` 素の状態、および `playwright install-deps` 後の `fc-match sans-serif`、`fc-match :lang=ja`、`fc-list` の実際の解決結果。
4. CDP `CSS.getPlatformFontsForNode` が headless（`chrome-headless-shell`）で動作するか、TextNode 単位・文字単位の粒度が得られるか、`glyphCount` が代替検出に足るか。
5. `document.fonts.status` が `loaded` → `loading` に戻る実挙動と、フォント読み込みの遅延発生条件。
6. WebKit (Playwright) から Web Inspector protocol に到達する公式経路が存在するか（本調査では見つからず）。
7. Firefox の CDP サブセットに CSS domain が含まれるか。
8. `fonts-*` 各パッケージのライセンス本文（Debian copyright）と `test-regular.ttf` の出自。
9. Google Fonts の CJK 分割数など具体的な数値（本調査では二次情報のみ。必要なら CSS API 応答から実測）。

---

## 10. 下流（#46）に渡す論点（判断はしない）

- 「宣言」の単位: ファミリ名のみ / フォントファイル / 和文カバレッジ / 環境フォント集合の同一性。
- 「保証」の意味: 取得完了（現行）／描画使用（Chromium のみ可能）／環境同一性（記録が必要）。
- 不一致・確認不能の扱い: 不成立として停止するか、確認不能として区別するか、対象外と宣言させるか。現行 failure 契約には区別が無い。
- エンジン間の非対称（CDP は Chromium のみ）を、`Chromium / Firefox / WebKit` を同格に扱う方針とどう整合させるか。
- 環境準備を vlint が担う場合、フォント供給は「同梱（ライセンス文添付）」「OS パッケージ供給」「アプリ側供給（現行 A4）」のどれに置くか。
- 本調査の候補手段はいずれも新規依存（CDP、fontconfig 環境変数、Inspector protocol）を伴うため、R4/R5（browser は Playwright が所有、明示 install）との整合確認が必要 **[解釈]**。

---

## 出典

一次（仕様・公式ドキュメント・ソース）:

- CSS Font Loading Module Level 3 — https://drafts.csswg.org/css-font-loading/
- CSS Fonts Module Level 4 — https://drafts.csswg.org/css-fonts-4/
- MDN `FontFaceSet.check()` — https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/check
- MDN `Document.fonts` — https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts
- W3C csswg-drafts #14379（open） — https://github.com/w3c/csswg-drafts/issues/14379
- CDP `CSS.pdl`（`getPlatformFontsForNode` / `PlatformFontUsage`） — https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/CSS.pdl
- Playwright `BrowserContext`（CDP は Chromium のみ） — https://playwright.dev/docs/api/class-browsercontext
- Playwright #20699（CDP と Firefox） — https://github.com/microsoft/playwright/issues/20699
- Playwright release notes（1.57 Chrome for Testing / `chrome-headless-shell`） — https://playwright.dev/docs/release-notes
- Playwright release notes（1.61 = 現行 pin の版） — 同上
- Playwright `nativeDeps.ts`（`install-deps` のフォント集合） — https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/nativeDeps.ts
- Playwright `Dockerfile.noble` — https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.noble
- Playwright Docker ドキュメント — https://playwright.dev/docs/docker
- fontconfig 設定ドキュメント（環境変数・`<reset-dirs>`・`rejectfont`） — https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user
- Chromium 旧 headless の fontconfig 取り扱い — https://chromium.googlesource.com/chromium/src.git/+/62.0.3178.1/headless/public/util/fontconfig.cc
- WebKit Inspector protocol `CSS.json`（`getFontDataForNode`） — https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/CSS.json
- Mozilla Bug 1180560 / 1244212 / 1173260 / 886041 — bugzilla.mozilla.org
- SIL OFL 1.1 全文 — https://openfontlicense.org/documents/OFL.txt
- IPA Font License v1.0（日本語一次） — https://moji.or.jp/ipafont/license/ 、OSI 掲載 — https://opensource.org/license/ipa
- Local Font Access API（WICG） — https://wicg.github.io/local-font-access/

リポジトリ内:

- `src/browser/readiness.ts`、`tests/integration/readiness.test.ts`、`src/contracts/config.ts`
- `docs/plans/2026-07-14-001-feat-vlint-plan.md`（A4、Risk 表、Implementation Constraints、FailureStage/Code 表）
- `tests/fixtures/app/pages/font-{ok,error,hang}.html`、`tests/fixtures/app/fonts/test-regular.ttf`
- `CONTEXT.md`

補助（本調査で原典を確認できていないもの。参考情報として扱い、主張の根拠にはしない）:

- fontsource/google-font-metadata（woff2 の subset 分割） — https://github.com/fontsource/google-font-metadata/
- firefox-source-docs remote/cdp（Firefox の CDP サブセット） — 本文未確認

## 置き場所について

`docs/research/` は新設。既存のドキュメント置き場は `docs/adr/`・`docs/agents/`・`docs/ideation/`・`docs/operations/`・`docs/plans/` で、`docs/plans/` の命名は `YYYY-MM-DD-NNN-<type>-<slug>-plan.md`。恒久的な調査メモの置き場をどこにするかは未決。
