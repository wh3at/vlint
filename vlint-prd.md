# vlint — UI Layout Check CLI PRD

## 背景

Web UIの文字折り返しやはみ出しは、実ブラウザで描画するまで発見しにくい。個別コンポーネントへ回帰テストを追加する運用では、開発者やAIエージェントがテスト追加を忘れると検知できない。また、CIだけで検査すると、PR作成後まで問題に気づけない。

検査のたびにURLを明示する方式にも同じ問題がある。利用者がvlintの実行だけでなく、今回どのページを検査すべきかまで判断しなければならず、指定漏れがそのまま未検査になる。

vlintは、対象プロジェクトで一度レイアウト契約と有限の検査ターゲット集合を設定すれば、以後は単一コマンドでその全体を実ブラウザ検査できる状態を作る。

## 製品名

**vlint**（visual lint）

## 製品定義

vlintは、対応OS・architecture向けの単一実行ファイルとして配布される独立CLIである。実装にはBunのsingle executableを使用し、ブラウザ操作にはPlaywrightを使用する。利用側にNode.js、Bun、npmその他の言語runtimeやpackage managerを要求しない。

Playwrightのライブラリコードとvlintの検査logicは実行ファイルへ含めるが、Chromiumなどのブラウザ実行ファイルは含めない。ブラウザの取得、保存、起動、互換性はPlaywrightの仕組みに委ね、vlint独自のbrowser build管理やcross-version再現性は製品要件にしない。通常の検査とブラウザの導入・更新は別操作とし、`vlint check` はブラウザを暗黙に導入・更新しない。

## 目的

対象プロジェクトで一度設定を行えば、開発者またはAIエージェントが `vlint check` を実行するだけで、宣言済みの全検査ターゲットへ共通のレイアウト契約を適用し、タブラベルの意図しない折り返しを目視や個別テストに依存せず決定論的に検出できるようにする。

vlint自体は自律的に起動しない。実行忘れを防ぐ場合は、利用側が既存の `check`、CI、git hook、AIエージェントの完了gateなどへ `vlint check` を一度組み込む。gateそのものの作成・管理はvlintの責務に含めない。

## 対象ユーザー

- Web UIを実装・修正するAIエージェント
- UI回帰をPR前に確認したい開発者
- 共通のレイアウト検査を複数プロジェクトへ導入するチーム

## カバレッジモデル

vlintが保証するのは、実行時に解決された有限の検査ターゲット集合をすべて検査したことまでであり、アプリケーション内の全ページを自動発見したことではない。

一つの検査ターゲットは、少なくとも次の組み合わせで表現する。

- 識別名
- 具体的なURL
- 必要に応じたbrowser state
- viewport
- ready条件
- locale、time zoneなどのブラウザ文脈
- 必要に応じた固定データや権限の前提

`/users/:id` のような抽象routeではなく、再現可能な `/users/fixture-user` のような具体URLを検査対象とする。固定データの準備やdev serverの起動は利用側が担う。

## 初版の利用体験

1. 利用者はOS・architectureに対応するvlint実行ファイルを導入する。
2. 利用者は初回または更新時に、対応Chromiumを明示的なブラウザ管理コマンドで取得する。
3. 利用者はプロジェクトへ言語非依存の宣言的な設定ファイルを置く。
4. 利用者は対象アプリケーションを起動し、必要ならbrowser stateとfixture dataを準備する。
5. 利用者はURLを指定せず `vlint check` を実行する。
6. vlintは設定されたTarget Providerから有限の検査ターゲット集合を解決する。
7. vlintは選択されたChromiumを起動し、各ターゲットを指定viewportとbrowser stateで開く。
8. vlintはWeb Fontとready条件を待ち、対象要素を計測する。
9. 全ターゲットを正常に検査でき、違反がなければ成功する。折り返しがあればレイアウト違反として非ゼロ終了し、検査を完了できなければ実行失敗として別の終了コードを返す。

単一ページの調査や再現には、Target Providerを解決せず、設定内の共通defaultだけを適用するad hoc実行を提供する。

```bash
vlint check
vlint check --url http://localhost:3000/settings
```

ブラウザ取得・更新の正確なサブコマンド名は実装設計で確定するが、通常の `vlint check` がブラウザを暗黙更新してはならない。

## 検査ターゲットの解決

初版は二種類のTarget Providerを提供する。

### Static Provider

設定ファイルへ具体的なターゲットを列挙する。小規模なプロジェクトや固定fixtureを持つプロジェクトの基本方式とする。

### Command Provider

利用側が指定した外部コマンドを子processとして実行し、標準出力からターゲット一覧をJSONで受け取る。外部コマンドは任意の言語で実装でき、vlintは利用側のソースコードやruntimeを直接loadしない。

```json
{
  "targets": [
    {
      "name": "project-settings",
      "url": "http://localhost:3000/projects/fixture/settings",
      "browserState": ".vlint/auth.json",
      "viewport": { "width": 1280, "height": 800 }
    }
  ]
}
```

Command Providerが非ゼロで終了する、timeoutする、不正なJSONを返す、必須fieldを欠く、または解決結果が0件になる場合は、レイアウト違反ではなく設定・実行失敗とする。

vlintは解決したターゲット数と各ターゲットの識別情報をterminal出力とJSON出力へ含める。ターゲットを黙ってskipしてはならない。

## 初版のレイアウト検査

初版は組み込みrule `tab-label-single-line` を提供する。設定がない場合は、既定instanceとしてsemantic tabを検査する。

### semantic tabとタブラベルの定義

- 既定の候補要素は、画面上に描画されている `[role="tab"]` とする。
- 選択状態、未選択状態、disabled状態はいずれも検査対象とする。非表示要素は対象に含めない。
- タブラベルは、候補要素内で実際に描画されている文字とする。`aria-label` など、画面上に描画されないaccessible nameは行数計測へ使用しない。
- 既定では候補要素全体をlabel regionとし、その内部に描画された文字が一つのvisual lineへ収まっているかを検査する。badgeや補助文字も既定では同じregionに含まれる。
- 描画文字を持たないicon-only tabは検査対象件数へ含めない。
- 複雑なtab構造では、rule instanceに候補要素からの相対label selectorを指定できる。指定時は各候補につき一つの描画要素へ解決されなければならず、0件または複数件になる場合はrule評価失敗とする。
- 追加の候補selectorと除外selectorを設定できる。意図した複数行表示は候補単位で明示的に除外できる。
- label region内の描画文字が複数のvisual lineへ分かれた場合をレイアウト違反とする。

行数判定の具体的なDOM計測algorithmはrule実装としてversion管理し、fixtureで互換性を固定する。

### Targetとruleの適用

- 設定されたすべてのrule instanceは、解決されたすべてのtargetへ既定で適用する。新しいtargetを追加した際にruleの指定を忘れて未検査になる方式は採用しない。
- 一つの評価単位を `target × rule instance` とし、違反と診断は両方の識別子を持つ。
- あるtargetで候補要素が0件でも、既定ではそのtargetの失敗にはしない。tabを持たないpageへ共通ruleを適用できるようにするためである。
- 各rule instanceは、明示的に許可しない限り、run全体の有効なtargetのどこかで一件以上のlabelを検査できなければならない。全体で0件の場合は無検査の成功を避けるため設定・実行失敗とする。
- tabが存在すること自体を保証したいtargetは、rule instanceごとの最低一致件数を指定できる。除外後の検査可能なlabel数がこれを下回る場合は、レイアウト違反ではなく設定・実行失敗とする。
- targetはrule instanceを明示的に無効化できる。また、target単位の除外selectorと最低一致件数を上書きできる。

viewport、device scale factor、locale、time zone、ready条件、timeoutを設定できる。vlintは `document.fonts.ready` 相当のWeb Font読み込み完了と設定されたready条件を待ってから計測し、それらを満たせない場合はレイアウト違反と区別して実行失敗を報告する。

## ブラウザと配布

- vlint本体はBunで生成した単一実行ファイルとしてOS・architecture別に配布する。
- 利用時にNode.js、Bun、npm、`node_modules`を要求しない。
- Playwrightと検査ruleはvlint実行ファイルへ含める。
- Chromium実行ファイルはvlint実行ファイルへ含めない。
- Chromiumの取得、保存、起動、Playwrightとの互換性はPlaywrightの仕組みに委ねる。vlintは独自のbrowser build allowlistやlock protocolを持たない。
- ブラウザの導入・更新は通常の検査とは別操作とし、`vlint check` は暗黙に導入・更新しない。
- 利用者はbrowser path、接続port、DOM計測scriptを用意しない。
- browserが未導入、破損、または起動不能の場合は、レイアウト違反ではなくbrowser setupまたは実行失敗とする。
- 実際に使用したbrowser名とversionを取得できる場合は診断情報へ含めるが、それを厳密な再現性保証には使用しない。

## 認証

- 公開ページは追加の認証設定なしで検査できる。
- 認証済みページは、利用側が生成したbrowser stateを読み込んで検査できる。
- browser stateは共通defaultまたはtarget単位で指定できる。
- vlintはログイン画面の操作、credential保存、MFA、CAPTCHA、認証provider固有処理を行わない。
- 認証前提が満たされずready条件へ到達しない場合は、レイアウト違反ではなく実行失敗とする。

## 決定論性の範囲

vlintにおける「決定論的」とは、screenshot差分や確率的な画像判定を使わず、計測時点のDOMと描画geometryへ明示されたruleを適用して判定することを指す。同じ描画状態と同じrule設定からは同じverdictを返す。

OS、browser version、font resource、アプリケーションデータなどが異なる環境間で、同一の描画状態やpixel単位の結果は保証しない。これらは可能な範囲で診断情報へ含め、問題調査の手掛かりとして扱う。

## 出力

- 人間が読める簡潔なterminal診断を返す。
- AIや他ツールが利用できるversion付き構造化JSONを返す。
- run summaryには、解決ターゲット数、検査完了数、一致要素数、違反数、実行失敗数を含める。
- 違反診断には、target名、URL、viewport、要素名または識別情報、適用rule、実測行数、要素位置を含める。
- 実行診断には、Target Provider、browser setup、navigation、認証、font、ready条件のどこで失敗したかを含める。
- browser名とversion、vlint version、platformを取得可能な範囲で含める。
- 途中で一件でも検査不能なtargetがあれば、run全体を「検査完了」として扱わない。

初版の終了コードは、少なくとも次の三分類を区別する。

- `0`: 全ターゲットの検査が完了し、違反なし
- `1`: 全ターゲットの検査が完了し、一件以上のレイアウト違反あり
- `2`: 設定、target解決、browser、navigation、認証、font、ready条件その他の理由で検査未完了

実行失敗とレイアウト違反が同時に存在する場合は、検査結果が不完全なため `2` を返し、JSON内には観測済みの違反も残す。

## 初版の対象外

- route、sitemap、Storybook、DOM linkなどからの自動探索
- アプリケーション内の全ページを検査したという網羅性保証
- crawlerによるtarget自動生成
- click、入力、scrollなどを伴う操作scenario
- 文字切れ、要素衝突、親領域からの突出、ページ全体のoverflow
- 色、contrast、余白、alignment、tap領域の検査
- screenshot比較とvisual regression
- dev serverの起動・終了
- fixture dataと認証stateの生成
- CI、git hook、AIエージェントの完了gateの作成・管理
- Chromiumをvlint実行ファイルへ内包すること
- `vlint check` 実行中のbrowser自動更新
- watch mode、複数browser engine、実モバイル端末
- 異なるOSやbrowser build間のpixel単位の同一性保証

自動探索が必要になった場合は、検査engineへ直接組み込むのではなく、有限のtarget一覧を生成する追加Target Providerまたは補助的なdiscover commandとして検討する。

## 成功条件

- BunまたはNode.jsが存在しないclean環境で、vlint単一実行ファイルが起動する。
- Chromiumを別途導入した状態で、`node_modules`なしにbrowser起動、page表示、DOM計測、JSON出力まで完走する。
- `vlint check` はURL引数なしで、設定から解決された全ターゲットを検査する。
- Static ProviderとCommand Providerの両方で同じ検査結果を得られる。
- 正常な一行tabを含むfixtureは常に成功する。
- 複数行へ崩れたtabを含むfixtureは常にレイアウト違反になる。
- 意図した例外を設定すると、その要素だけを検査対象外にできる。
- target解決0件、最低一致件数未達、認証失敗、font待機失敗、ready timeout、browser未導入を成功として扱わない。
- Command Providerの失敗や不正出力を、レイアウト違反と区別できる。
- 同じfixtureの安定した描画状態では、繰り返し実行して同じrule判定を返す。
- AIエージェントは一つのコマンドと診断出力だけで、違反targetと要素を特定できる。
- 利用者はbrowser path、接続port、DOM計測scriptを用意しない。

## 初版リリース判定

次のfixtureと実行環境を自動検証し、対応platformで結果が安定した時点を初版リリース条件とする。

- Static Providerによる正常、違反、例外、最低一致件数未達
- Command Providerによる正常、非ゼロ終了、timeout、不正JSON、0 target
- 公開pageとbrowser stateを使う認証済みpage
- navigation失敗、認証前提失敗、font timeout、ready timeout
- browser未導入、browser起動失敗、通常検査と分離されたbrowser導入・更新
- URLを直接指定するad hoc検査
- Node.js、Bun、package manager、`node_modules`が存在しないclean環境
- 同一条件での繰り返し実行による判定安定性
- terminal出力、JSON schema、終了コードのfixture検証

## 実装設計で確定する項目

以下は製品要件を変えずに、実装設計またはtechnical spikeで確定する。

- 設定ファイルの形式と正式なfile名
- browser取得・更新subcommandの正式名称
- 初版で配布するOS・architecture
- semantic tabの行数計測algorithmと診断用の要素識別方式
- JSON schemaの具体的なfield名とversioning方針
