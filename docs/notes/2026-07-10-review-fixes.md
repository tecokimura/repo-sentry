# 2026-07-10 コードレビュー対応記録

sentry-watch 最小版実装後の全体レビューで見つかった 11 件の課題と、その対応内容の記録。

## 背景

- sentry-watch 最小版(enrich 再実行 + 差分検出)の実装が完了した時点で、
  コード・スクリプト・ドキュメント全体をレビューした
- 課題の中心は「ドキュメントの実装への追随遅れ」「watch のテスト不在」 「docker-watch.sh
  の細部バグ」だった
- watcher の差分検出ロジック自体は fixture 検証で全変化パターンが正しく動作することを確認済み

## 対応内容

### ドキュメント

1. **README.md**: 「docker-run.sh: 一括実行」「sentry-export: PDF 生成」「sentry-watch: 継続監視」の
   3 セクションを新設。「現在の実装状態」を実態(export 動作確認済み・watch
   最小版完了)に更新。旧命名規則の出力例を現行の
   `reports/{プロジェクト名}/scan_{short}_{HASH}{YYMMDDHH}.md` 形式に修正
2. **docs/phase.md**: 現在の状態・次の優先課題・優先順位表(番号「13」重複を解消)を更新。
   全体構成ツリーに sentry-export / sentry-watch / fixtures を追加。watch セクションを
   「実装済み」表記にし、`watch/` サブディレクトリ出力と new_finding / removed_finding
   を含む拡張スキーマを反映
3. **HASH 表記の統一**: 現行の HASH は「プロジェクト名先頭 4 文字 + sha256 末尾 4 桁 = 最大 8
   文字」(例: `RECE77C1`)。README / phase.md の旧例(4 文字ハッシュ)を現行命名に統一

### スクリプト

4. **scripts/docker-build.sh**: export / watch を追加し全 5 image を一括 build に。
   `docker-build-export.sh` / `docker-build-watch.sh` を他スクリプトと同形式に統一
   (`--no-cache`・`REPO_SENTRY_EXPORT_IMAGE` / `REPO_SENTRY_WATCH_IMAGE`・ watch は `DENO_VERSION`
   build-arg 対応)
5. **scripts/docker-watch.sh**: `--output-dir` / baseline-scan / baseline-enriched が REPORTS_DIR
   外の場合に exit 2 で停止する検証を追加(従来は `reports/Users/...` 等へ
   黙って書き込まれていた)。検証は enrich 実行前に行う。未使用の DATE_FORMAT / REPORT_DATE
   読み込みとヘルプ記載を削除し、`--output-dir` のデフォルト説明を 実装(`watch/`
   サブディレクトリ)に修正
6. **scripts/docker-export.sh**: `--output` にも同様の REPORTS_DIR 配下検証を追加

### コード

7. **src/shared/urgency.ts**(新規): urgency 導出ルールを一本化。 `sentry-report/transformer.ts` と
   `sentry-watch/watcher.ts` にあった重複実装を削除
8. **src/sentry-watch/watcher.ts**: 差分ロジックを純粋関数 `diffReports()` に切り出し (ファイル I/O
   と分離してテスト可能に)。`--baseline-scan` の値を `WatchDiff.baseline.scanFile`
   に記録し、watch-report.md ヘッダーにも表示
9. **src/sentry-watch/watcher.test.ts**(新規): fixtures/watch-test/ を JSON import で 読み込む 10
   テスト。全変化パターン + scanFile 記録 + 変化ゼロ時の挙動を検証

### 開発環境

10. **deno fmt / lint**: `deno fmt` を全体適用(21 ファイル)。lint 2 件を修正 (`warnUrgencyMismatch`
    の未使用引数 `planLookup` 削除、`reference.test.ts` の import を `jsr:@std/assert@1`
    にバージョン固定)。`deno.json` の check タスクと README の `deno check` 例を全 4 CLI に拡張
11. **.gitignore**: `.env` → `.env*` + `!.env.example` に変更。`.env.ollama` 等の バリアントに API
    キーを書いても誤コミットされないようにした

## 検証

- `deno fmt --check` / `deno lint` / `deno task check`(全 4 CLI)/ `deno test`(16 件)すべて成功
- 全シェルスクリプトの `bash -n` 構文チェック成功
- watch CLI の fixture E2E 実行で差分検出・レポート生成を確認

## 残課題(次の優先)

1. P3-6: GitHub Actions 初期版の動作確認(workflow は実装済み。手順: docs/github-actions-test.md)
2. sentry-watch: baseline 自動切り替え・通知(次段階)
3. Slack / Teams 通知・定期実行は次段階
