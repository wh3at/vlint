# フォントの固定・供給・検証の限界

対象: [フォントの固定と使用確認はどこまで保証できるか](https://github.com/wh3at/vlint/issues/44)。
親: [検査環境の再現性と複数ブラウザー対応の仕様を定める](https://github.com/wh3at/vlint/issues/43)。
判断の引き継ぎ先: [フォントの宣言と必須条件の成立をどう定義するか](https://github.com/wh3at/vlint/issues/46)。

調査日: 2026-10-15（親セッションのUTC時計）。現行コードの確認基準: `main` の `7c39bd70b7f8e59df671c5a6daef075ab5b6dd40`、Playwright `1.61.1`。

## 調査の範囲と証拠

本ノートは一次資料の取得・読解とローカルファイルの確認による調査であり、ブラウザー実行による検証は行っていない。製品方針や採用手段は決めない。

- **文書確認**: CSS仕様、公式API・プロトコル、公式ソースコード、ライセンス本文を調査エージェントが取得した。親セッションもCDPの返却型、Firefox Fontsパネル文書、MDN互換性データ、OFL本文を取得・確認した。
- **ローカル確認**: 親セッションがreadiness/configコード、ADR、フィクスチャのSFNTメタデータ・ハッシュを確認した。フォント解決や描画挙動の実測とは区別する。
- **解釈**: 観測結果から何を保証できるかという推論。仕様の引用そのものではない。
- **未検証**: 実行環境・ビルドに依存する挙動。下記の追試候補を参照。

外部ソースの`main`/`master`は調査時点の上流であり、Playwright 1.61.1に含まれるすべての実装との同一性を意味しない。GitHubの提案・歴史的bugは規範仕様として扱わない。

## 結論

「フォントを保証する」は、少なくとも次の別々の主張に分ける必要がある。

| 主張 | 確認手段と限界 |
|---|---|
| 宣言がある | CSSに連結されたFontFaceや明示的に追加したFontFaceを`document.fonts`で扱える。システムフォント集合の列挙ではない |
| 読み込みが完了した | FontFaceSetの状態と各faceのエラーを確認できる。実使用・字形被覆・以後の状態維持を証明しない |
| 実際の描画で使われた | Chromium CDPにノード内テキストの使用フォント集計がある。FirefoxにもDevTools内部能力がある。WebKit Inspectorの該当APIはprimary fontのみ |
| 文字ごとの使用フォントが一致した | 今回確認したCDP集計型やWebKitのprimary font型からは直接得られない。これだけで別手段も含めて不可能とは言わない |
| 環境のフォント集合が同じ | ファイル・パッケージ・設定・解決結果の固定と記録が別途必要。fontconfigに隔離用機構はあるが、対象3エンジンのビルドでの効果は未検証 |

Playwrightの公開APIに3エンジン共通の「描画に使ったフォントを返す」手段は今回見つからなかった。**共通APIが見つからないことと、エンジンが情報を持たないことは異なる。** また、複数フォントが使われたという観測だけでは、意図しないフォールバックと断定できない。和文・ラテン・絵文字の意図的な分担もあるため、期待する条件との比較が必要になる。

## 現行vlintの確認範囲

`src/browser/readiness.ts`の`waitForFonts()`は次の2段階である。

1. deadline内で`document.fonts.status === "loaded"`を待つ。
2. 別の`page.evaluate`で`face.status === "error"`を数える。

時間内に収束しなければ`web-font` stageの`font-timeout`、失敗面があれば`font-load-failed`となる。これは読み込み状態の確認であり、実使用フォントの確認ではない。2回の操作をまたぐ原子的なスナップショットでもない。

`src/contracts/config.ts`の`TargetDefaults`にはフォント宣言がない。現在の設定に、期待するフォントファイル・描画フォント・環境フォント集合との照合契約はない。

[ルール計測区間の開始時と終了時だけ検証する](../adr/0004-check-only-rule-boundaries.md)は、ready状態の検証を境界でのサンプリングとし、区間内の状態維持や原子的な確認を保証しない。新しいフォント保証を検討する際にも、現行のready状態を区間全体の保証と読み替えてはならない。

## CSS Font Loading APIとCSS Fonts

一次資料: [CSS Font Loading Level 3](https://drafts.csswg.org/css-font-loading/)、[CSS Fonts Level 4](https://drafts.csswg.org/css-fonts-4/)、[MDN FontFaceSet.check](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/check)、[MDN Document.fonts](https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts)。

文書で確認した事項:

- FontFaceSetの`status`は`loading`/`loaded`。後から新しい読み込みが始まれば再び`loading`になり、ready promiseも更新される。ある時点の完了は、動的CSS・遅延読み込み後の完了を保証しない。
- `document.fonts`のface集合と、OSにインストールされたフォント集合は別である。
- `check()`は該当faceが読み込み済みまたはシステムフォントである場合、該当faceが空の場合にも`true`になりうる。存在しないファミリ名を与えても`true`になりうるため、存在・実使用の証明にならない。
- `check(font, text)`の`text`は`unicode-range`による絞り込みであり、MDNは個々の字形被覆を確認しないと明記する。
- `@font-face`は遅延取得を前提とする。未使用の宣言が`unloaded`のままでも、それだけでは条件違反といえない。
- `font-display: optional`などにより、宣言されたフォントと実使用フォントは一致しないことがある。
- CSSの照合手順には、インストール済みフォントへのフォールバックや、表示できない文字をmissing glyph等で示す手順がある。字形欠落がFontFaceの読み込みエラーになるわけではない。

したがって、フォントファイルの取得成功だけでは日本語・記号・絵文字まで期待どおり描画されたとはいえない。`getComputedStyle().fontFamily`も計算済みの候補リストであり、実際に選ばれたフォント一覧ではない。

[描画使用フォントを公開するCSSWG提案](https://github.com/w3c/csswg-drafts/issues/14379)はこのギャップを議論しているが、提案を実装済みAPIや規範仕様として扱わない。

## エンジン固有の観測

### Chromium

[公式CDP定義](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/CSS.pdl)の`CSS.getPlatformFontsForNode`は、指定ノードの子TextNodeを描画するために使ったフォントの統計を返す。返却型`PlatformFontUsage`は`familyName`、`postScriptName`、`isCustomFont`、`glyphCount`である。

このスキーマには文字位置・範囲やフォントファイルのハッシュはない。従って単一の返却だけから文字ごとの帰属や同一ファイルであることを証明できない。`isCustomFont`はWebフォント由来とOSフォントの分類に利用できるが、すべての`local()`等のケースを本調査で実測したわけではない。

[Playwright BrowserContext.newCDPSession](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)はChromium系のみをサポートする。採用する場合は固定したビルドとheadlessモードでの返却挙動の検証が必要。

### Firefox

[公式Fontsパネル文書](https://firefox-source-docs.mozilla.org/devtools-user/page_inspector/how_to/edit_fonts/)は、テキストに適用されたフォント、子孫の使用フォント、システムフォールバックを説明する。`font-family`宣言にあることも掲載理由に挙げるが、これを「使用されていない候補も必ず表示する」とは解釈しない。

[DevTools actor実装](https://searchfox.org/mozilla-central/source/devtools/server/actors/page-style.js)には、Rangeに対し`InspectorUtils.getUsedFontFaces`を呼ぶ経路がある。エンジン側に使用フォント情報があることと、Playwright利用者が公開APIから取得できることは別である。Range分割などを含む文字単位の観測方法の実用性は未検証。

[Mozilla公式CDP廃止告知](https://fxdx.dev/cdp-retirement-in-firefox/)と[Firefox 141の変更](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141)は、Firefox 141でCDP実装と`remote.active-protocols`を削除したと明記する。「FirefoxのCDPサブセットが使えるか」を今後の経路として残さない。PlaywrightはもともとMozillaのCDP実装を使っていなかったとも告知されている。

### WebKit

[Inspector protocol CSS.json](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/inspector/protocol/CSS.json)の`getFontDataForNode`はcomputed font cascadeの**primary font**を返す。これは文字ごとの部分フォールバック一覧ではない。

[Playwrightの内部プロトコル公開に関する回答](https://github.com/microsoft/playwright/issues/8231)は、内部APIの脆さや同一チャネルへのコマンド送信の問題を説明している。内部実装の存在は公開APIの保証ではない。

[Playwright Browsers](https://playwright.dev/docs/browsers)が説明するパッチ付きWebKitと、Apple Safari製品・実機での検査は同一ではない。

### 近似・補助的手段

- Canvasの幅比較は、期待する書体と別書体が偶然同じ幅になる場合などを排除できない。実使用フォントの証明とは区別する。
- [Local Font Access仕様](https://wicg.github.io/local-font-access/)は権限やユーザー操作等の制約を持つ列挙機能であり、どの文字を描画したかを返すAPIではない。[MDN互換性データ](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Window.json)の`queryLocalFonts`は調査時点でChrome 103以降、Firefox/Safariは未対応。3エンジン共通の検証手段にはならない。

## Linuxで供給・固定する手段

[fontconfig公式文書](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user.html)で確認できること:

- `FONTCONFIG_FILE`、`FONTCONFIG_PATH`等で設定ファイル・探索先を差し替えられる。
- `<dir>`、`<reset-dirs/>`、`<selectfont>`のaccept/reject、キャッシュ設定等により、フォント探索集合を制御する機構がある。
- マッチングは最も近い候補を返すが、要求と似たフォントであることを保証しない。`fc-match`が何か返ったことだけでは、指定フォントが存在する証明にならない。

**未検証**: Playwright 1.61.1の各ビルドが隔離設定をどう利用するか、他の探索経路やキャッシュが混入しないか。fontconfig自体の機能の存在と、全エンジンでの隔離成功を分ける。

[WebKitGTK公式wiki](https://trac.webkit.org/wiki/WebKitGTKFonts)はFontconfigでの選択、FreeType、HarfBuzzを説明するが、ページの鮮度や対象Playwrightビルドとの対応は別途確認が必要。古いChromium headlessの特例や、修正済みの古いFirefox bugを現行版の根拠にしない。

[Playwright nativeDeps.ts](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/registry/nativeDeps.ts)には、Noto Emoji、Unifont、Liberation、IPA、WenQuanYi、TLWG、FreeFont、X11系フォント等の導入がある。ただしこれは調査時点の上流であり、導入結果の完全な集合を列挙するものではない。base image・OS・追加パッケージ・探索設定も影響する。

解釈として、同じ名前のフォントをインストールするだけより、実ファイルのハッシュ、OS/ブラウザー/フォント関連ライブラリ、設定、解決集合を固定・記録する方が説明可能性は高まる。ただし、フォント集合の同一性だけでOS間の描画結果同一性までは保証できない。

## ライセンスと既存フィクスチャ

### 確認できた実体

親セッションの`fc-scan`とSFNT name table読み取りによるローカル確認:

- ファイル: `tests/fixtures/app/fonts/test-regular.ttf`
- バイト数: `50360`
- SHA-256: `fd327daf461db87b44a87def475d251bf03b997f7c07d9680592d75dbbfaad0b`
- PostScript名: `DMMono-Medium`
- 著作権: `Copyright 2020 The DM Mono Project Authors (https://www.github.com/googlefonts/dm-mono)`
- ライセンスメタデータ: SIL Open Font License 1.1、`http://scripts.sil.org/OFL`への参照。

[上流exports一覧](https://api.github.com/repos/googlefonts/dm-mono/contents/exports)の`DMMono-Medium.ttf`のblob SHAは`3e7a7634be5f0c2414f71f459c63c521ce59c5f2`。ローカルの`git hash-object --no-filters`も同じ値だった。サイズ・名前だけでなくGit blobの同一性を確認した。

`git ls-files '*LICENSE*' '*OFL*' '*NOTICE*'`では独立した追跡済み文書は見つからなかった。**埋め込み表示が存在することと、独立したライセンス文書・出所記録を持つことは別である。** 暫定版の「出自・ライセンス表示が見当たらない」は訂正する。

### 配布時の条件

[OFL 1.1本文](https://openfontlicense.org/documents/OFL.txt)の条件2は、再配布物に著作権表示とライセンスを含めることを要求し、独立テキスト・可読ヘッダ・容易に閲覧できるメタデータの形を認める。条件1はフォント単体での販売、条件3は改変版のReserved Font Name、条件5はライセンス維持等を定める。

[OFL FAQ](https://openfontlicense.org/ofl-faq/)にも埋め込み・バンドル等の説明があるが、ライセンス名とURLだけで特定の配布形態が適法か、本調査で法的結論は出さない。独立文書がないことだけで違反とも断定しない。

また、OS依存フォントはOFL一種類とは限らない。例として、配布元の[FreeFont copyright](https://tracker.debian.org/media/packages/f/fonts-freefont/copyright-20211204svn4273-2)はGPLとフォント例外、[WenQuanYi copyright](https://tracker.debian.org/media/packages/f/fonts-wqy-zenhei/copyright-0.9.45-8)はGPL・埋め込み例外・M+、[IPAライセンス](https://moji.or.jp/ipafont/license/)は独自条件を示す。

vlintがファイルやコンテナを再配布する場合と、利用者が配布元からOSパッケージを取得する操作を支援する場合は、配布主体が異なりうる。ただし「OSパッケージなら常にvlintは再配布者ではない」とは言えない。実際の配布形態・バージョンごとに通知・ソース提供等の条件を確認する必要がある。

## 未検証事項と追試の切り分け

文書調査の完了は、以下が実行検証済みという意味ではない。採用する保証・手段が決まった時点で必要な追試を選ぶ。

| 未検証の問い | 追試で観測するもの |
|---|---|
| 3エンジンでフォント集合を隔離できるか | 固定したOS/Playwright上で、既知の異なる字形・幅を持つ限定フォント集合と対照環境を使う。探索設定・実ファイル・解決結果・描画を記録。`fc-match`とブラウザー結果の差だけでは環境変数無視と断定しない |
| 対象ChromiumのheadlessでCDPが何を返すか | ラテンのみ・和文混在・意図的フォールバック・字形欠落・local()の既知ページでAPI応答を記録。glyph数を文字数と同一視しない |
| 動的フォント・optionalの時点差 | 遅延読込と読み込みイベント、境界確認、描画変化を記録。現在の境界サンプリング契約に照らして評価 |
| 対象OSの実際のフォント集合 | 固定したイメージ上で導入前後のファイル/ハッシュ/設定/パッケージ/`fc-list`を記録 |
| Firefox/WebKit内部能力を別経路で使う実用性 | 公開契約・版固定・保守負担と、実際に必要な粒度が得られるかを確認。共通API不在から不可能と一般化しない |

これらは全ての製品選択肢に必須の追試ではない。例えば描画使用の完全一致を保証しない選択肢なら、それを証明する追試は不要となる。反対に必須保証へ採用するなら、文書だけで成立済みとしてはならない。

## 次の判断に渡すもの

以下は既存の[フォントの宣言と必須条件の成立をどう定義するか](https://github.com/wh3at/vlint/issues/46)で扱う問いであり、本調査は回答しない。

- 宣言の対象をファミリ名・フォントファイル・文字範囲・許可フォールバック集合・実行環境のどこに置くか。
- 読み込み完了、実使用、環境同一性のどこを必須条件として約束するか。
- 条件不成立と確認不能をどう区別するか。確認不能な必須条件を満たしたと扱ってはならないという地図の出発条件とどう整合させるか。
- 日本語・ラテン・絵文字が意図的に別フォントとなる例、未使用の宣言、動的フォントをどの範囲で扱うか。
- 3エンジンで共通に保証する境界と、エンジン固有の観測を分けるか。
- 採用候補に隔離や内部APIが必要なら、どの実証を判断前に追加するか。

ブラウザー環境の固定全体は別の調査・判断チケットが扱うため、本ノートではフォントとの接点だけを記録した。製品コードの変更・ブラウザーインストール・再配布物の変更は行っていない。
