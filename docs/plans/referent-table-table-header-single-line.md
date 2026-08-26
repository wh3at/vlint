# Referent Table: Table Header Single-Line Rule

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 初出定義 | 候補語 |
| --- | --- | --- | --- | --- | --- | --- |
| Issue #17「ネイティブHTMLとARIA tableを自動検出する」 | 個別マーカーなしで検査対象を見つける | native tableまたはARIA table/gridで列方向の見出しとして機能する描画要素 | 記録 | semantic discovery → 除外判定 → 描画計測 | column header candidateとは、列見出しsemanticsまたは追加selectorによって検査候補となる要素を指す | column header candidate |
| Issue #17「実描画のテキスト行数を計測する」 | CSS宣言ではなくviewport上の結果を判定する | 候補内の非空テキストノードが占める視覚上の行位置 | 値 | 描画計測 → 行位置のgroup化 → 行数判定 | rendered text lineとは、候補内の文字断片が同じ視覚行に属すると判定された集合を指す | rendered text line |
| Issue #17「異なる行位置が2つ以上あれば違反」 | 意図しない列見出し折り返しを検出する | 一つの候補の描画文字が複数の視覚行に分かれた観測結果 | 事象 | 行数判定 → 違反記録 | table header wrap violationとは、検査対象の列見出しで複数のrendered text lineを観測したことを指す | table header wrap violation |
| Issue #17「意図的に複数行を許す列見出し」 | 意図した折り返しを検査対象から外す | 設定された除外selectorに候補自身が一致した結果 | 状態 | semantic discovery → 除外判定 → 検査対象外 | excluded header candidateとは、除外selectorに一致して描画計測へ進まない列見出し候補を指す | excluded header candidate |
| Issue #17「候補0件を許可するケースとselector欠落として失敗させたいケース」および既存rule契約 | 無検査のgreenとtableのないtargetを区別する | target単位の検査件数とrun全体の検査件数が設定された下限または明示許可を満たすか | 開始条件 | 候補計測完了 → 件数契約判定 → rule/run結果 | candidate coverage contractとは、target最低件数とrun全体0件許可を別々に評価する条件を指す | candidate coverage contract |
| Issue #17「機械判定可能な結果」 | 人間と自動処理が同じ観測根拠を追跡できるようにする | locator、geometry、行数、行位置、候補種別、判定許容情報、除外診断 | 記録 | 計測または除外判定 → terminal/JSON出力 | measurement evidenceとは、判定を再調査するために出力へ残す観測値と識別情報を指す | measurement evidence |
