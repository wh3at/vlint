# 3エンジンを再現可能に配布・実行できる条件

対象: [3エンジンを再現可能に配布・実行できる条件は何か](https://github.com/wh3at/vlint/issues/45)

## 結論と調査範囲

Playwright 1.61.1にはUbuntu 24.04 x64向けのChromium・Firefox・WebKitの成果物と依存定義がある。ただし、**現行vlintの配布・導入・検証・結果形式はChromium headless shell専用**であり、3エンジンでのBunコンパイル配布と既存ルールの動作は実証していない。

固定の単位はエンジン名や表示バージョンだけでは足りない。Playwright版、ブラウザー成果物、ホストOS・アーキテクチャ、依存ライブラリ、フォント、実行オプションを区別する必要がある。どこまで固定・確認し、何を再現性として保証するかは後続の製品判断である。

- コード読解の基準は[main d2d5ee8](https://github.com/wh3at/vlint/tree/d2d5ee8d70df32a85caf39f9da31fe819e124a2f)。研究ブランチの古いコードではない。
- 外部仕様・実装は原則Playwright `v1.61.1`、Bun `bun-v1.3.14`の一次資料で照合した。現行サイトの最新版の説明を固定版へ適用しない。
- ブラウザーの導入・起動、コンパイル済み3エンジンの実行、実OSとの比較は行っていない。後述の合成テストは実ブラウザーの測定ではない。
- 本書は事実・推論・未検証事項を整理する調査成果物であり、実装仕様ではない。製品コードは変更していない。

用語はリポジトリの`CONTEXT.md`に従う。**検査対象プラットフォームは利用者の閲覧環境であり、検査実行ホストとは異なる。** 現行の`devices`はviewport等のエミュレーションパラメーターで、iPhone・Windowsなどのプラットフォーム宣言そのものではない。同じviewportやUAを与えただけで実OSの表示再現が成立するとは扱わない。

## 1. 現行vlintの事実（コード読解）

以下のパスはすべて上記mainに対するもの。

| 領域 | 確認したこと | 根拠 |
| --- | --- | --- |
| 依存固定 | Playwright `1.61.1`、Bun `1.3.14`。ビルド・テスト前にBun版の厳密一致を検査する | `package.json`, `scripts/check-runtime.ts` |
| 管理対象・起動 | `MANAGED_BROWSER_NAME = "chromium-headless-shell"`、`chromium.launch({headless: true, executablePath})`のみ | `src/browser/install.ts`, `src/browser/lifecycle.ts` |
| コンパイル | `bun-linux-x64-baseline`。Playwrightの`package.json`と`browsers.json`をビルド時にJSへ埋め込み、`chromium-bidi/*`をexternalにする。ブラウザー実行ファイルは同梱しない | `scripts/build.ts`, `README.md` |
| 実バージョン検証 | 実行ファイルへ`--version`を渡し、stdout中の4要素の数字列を期待`browserVersion`と文字列比較する。非0終了・タイムアウト・不一致は`browser-incompatible` | `src/browser/install.ts`: `probeBrowserVersion`, `verifyActualBrowserVersion` |
| checkとstatus | `check`は配置・権限の確認後、実バージョンも検証する。`browser status`は配置・アクセス・revisionディレクトリの検査だけで、実バージョンを問い合わせない | 同: `resolveManagedExecutableForCheck`, `inspectBrowserRequirements`; `src/commands/browser-status.ts` |
| キャッシュ・環境変数 | 標準キャッシュを前提にChromiumのディレクトリを走査する。`PLAYWRIGHT_BROWSERS_PATH`はinstall/checkで拒否。installでは`PLAYWRIGHT_DOWNLOAD_HOST`と`PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST`も拒否する | `src/browser/install.ts` |
| 明示的準備 | `browser install --with-deps`がPlaywrightの内部registryの`installDeps`を特権ワーカーから呼ぶ。`check`は導入を行わない | 同: `runDependenciesInstallerWorkerMain`, `installBrowserDependencies` |
| OS・依存 | 配布インストーラスクリプトはUbuntu 24.04 x64を要求するが、バイナリ自身には同じOSゲートがない。deb/README/CI/リリース検証コンテナのapt一覧はChromium向け21パッケージ＋`ca-certificates`＋`fonts-liberation` | `scripts/package-release.ts`, `README.md`, `.github/workflows/ci.yml`, `tests/release/Containerfile` |
| 実行単位 | 1 runで1回起動した`Browser`接続を共有し、ケースは最大2並列。これを単一OSプロセス、または将来の3エンジンで必ず3プロセスになるという意味には読めない | `src/browser/lifecycle.ts`, `src/run/orchestrator.ts` |
| コンテキスト | viewport/screen/DPR/isMobile/hasTouch/locale/timezoneを渡す。`isMobile: false`も省略しない。プロファイルはvlint設定の自前定義で、Playwrightのデバイス一覧を自動適用していない | `src/browser/lifecycle.ts`, `src/config/schema.ts` |
| 設定・ケース | 設定のトップレベル許可キーはdevices/provider/defaults/rules。エンジン指定はない。ケースは対象ページ×デバイスで、エンジン識別子を持たない | `src/config/schema.ts`, `src/contracts/config.ts`, `src/contracts/result.ts` |
| 結果環境 | `environment.platform = "linux"`, `arch = "x64"`, `browser.name = "chromium"`が固定リテラル。versionは`browser.version()`由来で、起動できなければnull | `src/run/orchestrator.ts`, `src/contracts/result.ts` |
| 未記録情報 | checkの結果にはホストのディストリビューション版、Playwright版、ブラウザーrevision、成果物同定情報、glibc、フォント構成、コンテナ同定情報がない。statusは期待revision/版/パス/キャッシュ等を持つが単一ブラウザー前提 | `src/contracts/result.ts`, `src/commands/browser-status.ts` |
| 検証資産 | CI定義はUbuntu 24.04、管理ブラウザーの導入と統合・受け入れはChromium前提。リリース検証コンテナはUbuntuベースをdigest指定するが、aptのバージョンは指定していない | `.github/workflows/ci.yml`, `tests/release/Containerfile` |

内部registryの利用、manifest埋め込みの文字列置換、externalの扱いは公開APIだけの統合ではない。Playwright更新時にはこの接続点も再確認する必要がある（コード構造からの推論）。

## 2. Playwrightのブラウザー固定・ホスト選択（一次ソース）

### 成果物の固定値

[`browsers.json`][manifest]の関連項目:

| 成果物 | revision | browserVersion |
| --- | --- | --- |
| chromium | 1228 | 149.0.7827.55 |
| chromium-headless-shell | 1228 | 149.0.7827.55 |
| firefox | 1532 | 151.0 |
| webkit | 2311 | 26.5 |

ローカル`node_modules/playwright-core/browsers.json`の対応値も確認した。Firefoxの`151.0`とWebKitの`26.5`は**2要素**で、Chromiumの4要素形式とは異なる。表示バージョンとPlaywrightのrevisionは別の識別子である。

WebKitにはOSごとのrevision overrideがあり、例としてmac14は2251、debian11は2105、ubuntu20.04は2092となる。[registry][registry]はoverride時の`browserVersion`を`undefined`にする。これら古いホストを新たにvlintの対応範囲へ含める決定はしていない。

### OSごとに同じ成果物とは限らない

[registryのダウンロード表][registry]はUbuntu 24.04向けFirefox/WebKitのzipを定義する。WebKitはUbuntu/Debianのリリースごとに別のzipを選ぶ。Chromium x64の複数Linuxリリースは同じChrome for Testingのlinux64 zipを共有する。

[hostPlatform][host]と[linuxUtils][linux]はLinuxのアーキテクチャと`/etc/os-release`のID・VERSION_IDからホスト分類を決める。未対応ディストリビューションにはUbuntu 24.04へのフォールバック経路があり、`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE`による上書きもある。registryは非公式プラットフォームのダウンロード時に警告するが、必ず停止するわけではない。

**重要な訂正:** フォールバックしても期待バージョンが変わらない場合があり、Chromiumでは成果物自体を共有している。したがって**現行vlintのバージョン一致検証がフォールバックを必ず検出する、とは言えない**。バージョン一致はホストOSの適合性やライブラリ同一性の証明ではない。バイナリ自身にOSゲートがないことと合わせ、必要条件を満たさない代替環境を拒否する契約は別途検討が必要である（上記事実からの推論）。

[固定版のシステム要件][intro]にはUbuntu 24.04 x64が含まれる。[Docker文書][docker]はFirefox/WebKitのブラウザービルドがglibc向けで、Alpine等のmuslディストリビューションを非対応とする。これは「Chromiumならmuslで動作保証される」という意味ではない。

## 3. 実バイナリの版をどう観測できるか

### `browser.version()`はエンジン共通の独立検証ではない

| エンジン | 固定版の実装 | 読み取れる範囲 |
| --- | --- | --- |
| Chromium | [`crBrowser.ts`][cr]がCDP `Browser.getVersion`のproductから取得 | 接続したブラウザーのプロトコル応答由来 |
| Firefox | [`ffBrowser.ts`][ff]がJuggler `Browser.getInfo`から取得 | 接続したブラウザーのプロトコル応答由来 |
| WebKit | [`wkBrowser.ts`][wk]の`const BROWSER_VERSION = '26.5'`を返す | Playwrightライブラリ内の定数。実WebKitバイナリの版を独立に確認した値ではない |

WebKitの版を結果へ載せることと、期待成果物が実際に起動したことを検証することは区別する必要がある。いずれの表示版も成果物のハッシュ検証そのものではない。

Linux WebKitの実行入口は[`pw_run.sh`][wrapper]で、引数をMiniBrowserへ渡す。上流[MiniBrowserのGTK実装][minibrowser]には`--version`があるため、「ラッパーなのでバージョン照会不可能」と断定できない。ただしこれは上流mainの参考情報で、Playwright revision 2311の実出力は未測定。headless時にはWPE側を選ぶ分岐もある。仮に取得できてもWebKitGTK/WPEのライブラリ版を`26.5`やrevisionと同一視できない。

### 実行した合成ロジックテスト

mainの実関数をBun 1.3.14でimportし、次を実行した。ブラウザーは起動していない。

| 関数・入力 | 観測した結果 |
| --- | --- |
| `verifyActualBrowserVersion`へ期待`151.0`、スタブprobeのstdout=`Mozilla Firefox 151.0`、exit=0、timeout=false | `browser-incompatible` |
| `rejectAmbientBrowserOverrides("check", {PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright"})` | `browser-cache-override-unsupported` |

前者のstdoutは実Firefox出力ではなく合成入力である。ただし現行検証が4要素の一致結果と2要素の期待値を文字列比較する以上、Firefoxの期待`151.0`・WebKitの期待`26.5`にはそのまま流用できないことはコードから確定する。

`browser status`のreadyはこの実バージョン検証を含まない。配置・権限の確認、版の確認、実起動成功は別段階である。

## 4. 導入・依存・コンテナ・Bunの条件

### エンジン別のシステム依存

[`nativeDeps.ts`][deps]はUbuntu 24.04 x64についてtools/chromium/firefox/webkitを別の配列として持つ。toolsにはフォントやxvfbが含まれる。Firefoxには`libgtk-3-0t64`等、WebKitにはGStreamer・`libicu74`・`libenchant-2-2`等があり、**現行vlintのChromium向けapt一覧だけでは3エンジンの依存を宣言したことにならない**。

Playwrightの依存導入は[依存処理][dependencies]を通じてapt等を実行し、必要なら昇格する。vlintは既存の明示的`--with-deps`と特権ワーカーを持つが、対象は現在shellのみ。3エンジン対応時には、管理対象、debの依存、セットアップ、CI/コンテナの前提を整合させる必要がある（推論）。

依存パッケージ名だけの固定と、取得されるパッケージ版の固定は異なる。またtoolsがフォントを追加することは、検査対象プラットフォームに必要なフォント条件を満たしたことの証明ではない。

### コンテナの選択肢と現在の衝突

[公式Dockerfile.noble][dockerfile]はUbuntu nobleをベースにブラウザーと依存を導入し、`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`を設定する。[公式文書][docker]はPlaywrightパッケージ自体は別途必要で、プロジェクトとイメージのPlaywright版を合わせるよう述べる。MCRの[タグ一覧][mcr]で`v1.61.1-noble`の存在を調査エージェントが確認した。イメージのpull・実行や具体的digestの取得はしていない。

この標準環境変数は現行vlintの拒否条件に該当する。したがって**公式イメージを無変更で使えば現行vlintは拒否する**。これは3エンジンやコンテナが将来利用不可能という意味ではなく、現在のキャッシュ契約との衝突である。変数を外して通常キャッシュへ別途導入する案、vlintの明示的管理先を設計する案、自前イメージを作る案等の採否は未決で、動作も未実証。

公式文書には非root・sandbox・seccomp、`--init`、Chromium向け`--ipc=host`等の注意がある。これらを無条件の製品要件とはしない。`run-server`によるリモート実行も公式の選択肢だが、現行vlintはローカルlaunch前提で、そのまま利用できるわけではない。

Dockerでは[tagとは別にdigestでイメージを固定できる][digest]。既存のvlint検証用Containerfileもベースdigestを使う。しかし、ベースdigestを固定しても、その後の未固定`apt-get install`まで不変になるわけではない（Containerfile読解からの推論）。ブラウザー・フォント・依存を含む完成イメージの固定と、そこからの更新手順は別の判断対象である。digestの固定だけでページ内容やホストカーネルまで同一になるとは主張しない。

### Bunコンパイル配布

[固定Bun 1.3.14の実行ファイル文書][bun]は`bun-linux-x64`をglibc向けとし、baselineとmodernを別のCPU互換ターゲットとして説明する。現行vlintはbaselineを選ぶ。最新版サイトの「同じバイナリへ解決される」という説明は固定版の根拠に使わない。

JS・manifestの埋め込みとブラウザー実行ファイルの配布は別である。Firefoxの既定起動は[`firefox.ts`][firefox]のJuggler経路で、`moz-*` channel時のみBiDi側へ委譲する。既定FirefoxがChromium BiDiを使う、とは読めない。ただし、現行buildのexternal・遅延require・内部registry・ダウンローダー・周辺ファイルがFirefox/WebKitでもコンパイル後に成立するかは未実証。Bunのバグ報告を一般的な動作仕様とは扱わない。

## 5. エンジンと製品、エミュレーションの限界

[Playwrightのブラウザー文書][browsers]が区別しているもの:

- Chromiumの通常ビルド、別成果物のheadless shell、Chrome/Edgeのbranded channelは同一の実行対象ではない。`channel: 'chromium'`の新headlessとshellには挙動差がありうる。
- PlaywrightのFirefoxはパッチ適用版で、一般配布のbranded Firefoxをそのまま動かす方式ではない。
- PlaywrightのWebKitはSafari製品ではなく、branded Safariには対応しない。文書はSafariに近い経験にはmac上のWebKitを勧め、OSごとの機能差にも言及する。Linux WebKitをiPhone Safariの表示保証に読み替えない。

[`isMobile`の公式記述][params]はFirefox非サポートを明記する。一方、同タグの[`browserContext.ts`][context]にFirefox固有の拒否はなく、[`ffBrowser.ts`][ff]は値をJugglerへ転送する。調査エージェントが追った[`TargetRegistry.js`][targets]ではviewportSizeとDPRを扱うが、isMobileを消費する経路は見つからなかった。

**非サポートと「例外で拒否する」は同義ではなく、これらは必ずしも資料間の矛盾ではない。** 少なくとも例外が出ないことをもってモバイルエミュレーション対応と認定できない。`isMobile: false`を渡すだけで失敗すると断定する根拠もない。viewport・DPR・touch・screen・UAの実効挙動は個別に確認が必要である。

[エミュレーション文書][emulation]のデバイス展開例はパラメーターの設定方法であり、実OS再現の保証ではない。エンジンとデバイスの有効組み合わせをvlintがどう定めるかは後続判断となる。

## 6. 既存DOM計測との互換性（コード読解・未実証）

現行の組み込みルール型は5つ＋`local`。`table-cell-clipping.ts`は独立したルール型ではなく、クリップ形状を扱う共有モジュールである。全ルールがページ内JSだけで完結するわけではなく、例えばタブ行数のクラスタリングはホスト側の純関数で行う。

| ルール・境界 | エンジン差を調べる接点 |
| --- | --- |
| tab-label-single-line / table-header-single-line | `Range.getClientRects()`のテキスト片・行矩形、computed line-height、行クラスタリングの入力 |
| page-horizontal-overflow | scrollWidth/clientWidth/innerWidth、BCR、局所スクロール領域、丸めと帰属 |
| table-cell-text-overlap | セルとテキストの矩形、隣接関係、computed clip-path文字列の解析、Canvas/Path2Dによる形状判定 |
| svg-text-clipping | Canvas measureTextのactualBoundingBox、SVGのCTM・文字位置・advance、computed styleの対応判定 |
| 共通のready境界 | URL、ready selector、`document.fonts.status`の観測 |
| local | ユーザーコードが選ぶ計測API。組み込みルールの確認だけでは互換性を証明できない |

根拠: mainの`src/rules/*.ts`, `src/browser/measurement.ts`, `src/contracts/config.ts`, `README.md`。

これらは**差が入りうる箇所の同定**で、3エンジンで不具合や判定差を測定した結果ではない。エンジン間の差は検出すべき実際のレイアウト差である可能性もあり、「全エンジンの結果を一致させる」が正しい受け入れ基準とは未決である。

とくにSVGなどは非対応条件のテキストを検査対象から除外するため、起動成功やcleanだけでは検査の成立を確認できない。検査件数・対象集合・除外条件と期待する違反の検出を併せて見る必要がある（コードからの推論）。

既存ADRの固定URL照合、ルール計測区間の開始・終了時のready確認、宣言された最低検査件数、実測URLの出力は維持する前提となる。ブラウザー追加自体はこれらを弱める理由にならない。特にADR-0004により区間全体の状態維持は保証しない。

## 7. 未検証事項と後続判断への引き渡し

### 実証が必要なこと

| 確認対象 | 観測・記録する内容 |
| --- | --- |
| Bunコンパイル後の3エンジン | 対象Ubuntu 24.04 x64のクリーン環境で、明示的導入、内部ワーカー、起動、context、ページ内計測、終了まで。ソース実行だけで代替しない |
| 成果物同定 | Firefox/WebKitの実`--version`出力と観測経路、期待revision/成果物と実体の対応。WebKitのライブラリ定数を独立検証としない |
| 必須環境の拒否 | 未導入、誤revision、版文字列だけ同じ別成果物、非対応ホスト・override・依存欠落等。バージョン照合だけでOSフォールバック拒否を保証しない |
| デバイスパラメーター | エンジン別のviewport、screen、DPR、touch、UA、meta viewport。FirefoxのisMobile非サポートも踏まえる |
| 既存ルール | fixtureごとの違反・計測値・elementsInspected・対象集合・非対応条件。エンジン差とルール不備を区別する |
| 再現性と閲覧環境への有用性 | 同一固定環境での反復、別ホストでの再実行、iPhone/Windows等の実際の閲覧環境との代表例比較。前二者の成功を後者の証明にしない |
| コンテナ運用・資源 | キャッシュ契約、権限・sandbox、ネットワーク、必要ライブラリ、フォント、完成イメージの識別、メモリ・並列度。実測していないプロセス数を固定しない |

これらは実装完了を示すチェック済み項目ではなく、仕様に受け入れ条件を定めるための入力である。

### 既存の後続チケットが所有する判断

- [ブラウザー環境の準備と固定をどこまで引き受けるか](https://github.com/wh3at/vlint/issues/47): 検査対象プラットフォーム・製品指定と実行エンジン／成果物／フォントの対応、成立を確認する実証、対応ホスト、管理・導入・更新・固定の責任、ネイティブ／コンテナ、版検証とstatusの保証、未成立条件の扱い。
- [検査環境の設定と受け入れ基準をどう統合するか](https://github.com/wh3at/vlint/issues/48): 設定とケースの軸、環境情報の出所と出力、既存設定・結果の移行、エンジン差を結果へ説明する方法、ルールの検査成立・反復再現性・想定閲覧環境への有用性を分けた受け入れ基準。

本調査から将来のバイナリ配布単位、エンジンの並列実行方式、全エンジンの結果一致、iPhone/Windowsへの対応済み認定は決まらない。mapの「実OS／実機での完全再現は対象外」と、想定する閲覧環境に有用な検査という目的が両立するかも、人間との後続判断に残す。

## 前版からの訂正要点

- Firefox `151.0`は2要素。4要素検証の一般化は不可。
- WebKitの`browser.version()`は実バイナリ由来ではない。`pw_run.sh`の存在だけでCLI照会不可能とも言えない。
- OSフォールバックを版一致検証が必ず検出する、という推論は撤回。
- Firefoxの`isMobile`非サポートと、値を例外で拒否しない実装を矛盾扱いしない。
- Bunの最新版説明を1.3.14へ適用しない。バグ報告をexternal解決の仕様にしない。
- manifest埋め込みから将来のエンジン選択方式は決まらず、3エンジン化からプロセス数も決まらない。

[manifest]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/browsers.json
[registry]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/registry/index.ts
[host]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/utils/hostPlatform.ts
[linux]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/utils/linuxUtils.ts
[intro]: https://github.com/microsoft/playwright/blob/v1.61.1/docs/src/intro-js.md
[deps]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/registry/nativeDeps.ts
[dependencies]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/registry/dependencies.ts
[cr]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/chromium/crBrowser.ts
[ff]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/firefox/ffBrowser.ts
[wk]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/webkit/wkBrowser.ts
[wrapper]: https://github.com/microsoft/playwright/blob/v1.61.1/browser_patches/webkit/pw_run.sh
[minibrowser]: https://github.com/WebKit/WebKit/blob/main/Tools/MiniBrowser/gtk/main.c
[firefox]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/firefox/firefox.ts
[docker]: https://github.com/microsoft/playwright/blob/v1.61.1/docs/src/docker.md
[dockerfile]: https://github.com/microsoft/playwright/blob/v1.61.1/utils/docker/Dockerfile.noble
[mcr]: https://mcr.microsoft.com/v2/playwright/tags/list
[digest]: https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier
[bun]: https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/bundler/executables.mdx
[browsers]: https://github.com/microsoft/playwright/blob/v1.61.1/docs/src/browsers.md
[params]: https://github.com/microsoft/playwright/blob/v1.61.1/docs/src/api/params.md#context-option-ismobile
[context]: https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/browserContext.ts
[targets]: https://github.com/microsoft/playwright/blob/v1.61.1/browser_patches/firefox/juggler/TargetRegistry.js
[emulation]: https://github.com/microsoft/playwright/blob/v1.61.1/docs/src/emulation.md
