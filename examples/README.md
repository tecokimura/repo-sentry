# examples/

Phase 3 Stable の動作確認に使用した実案件のサンプルファイルセット。

## ファイル構成

```
examples/
  critter-private-api/        CRITTER_PRIVATE_API-master 実案件（2026-06）
    enriched_critter_*.json   sentry-enrich 出力（24 件 / High 4 件）
    report_critter_*-plan.json  sentry-report AI プラン出力
    report_critter_*.md       sentry-report 最終レポート
```

## 用途

- `--plan-input` テスト: `report_critter_*-plan.json` を再利用して Renderer のみ検証
- 品質ベースライン: 出力形式・文章品質の基準として参照
- 回帰テスト: 新機能追加後に同じ enriched.json を流して差分確認

## ファイルの配置方法

実行後に生成された reports/{project}/ 配下の3ファイルをここにコピーしてください。

```bash
cp reports/CRITTER_PRIVATE_API-master/enriched_critter_*.json examples/critter-private-api/
cp reports/CRITTER_PRIVATE_API-master/report_critter_*-plan.json examples/critter-private-api/
cp reports/CRITTER_PRIVATE_API-master/report_critter_*.md examples/critter-private-api/
```

## 注意

このディレクトリのファイルには実プロジェクトの脆弱性情報が含まれます。
公開リポジトリへのプッシュは行わないでください（.gitignore で除外を推奨）。
