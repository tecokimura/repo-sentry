# GitHub Actions 動作確認手順

最終更新: 2026-06-29

## 現在の状態

`.github/workflows/security-scan.yml` を `develop` ブランチに実装済み。
このドキュメントは初回動作確認のための手順書です。

---

## ステップ 1: GitHub Secrets の設定

リポジトリページを開く:

```
https://github.com/tecokimura/repo-sentry
```

1. **Settings** タブ → 左サイドバー **Secrets and variables** → **Actions**
2. **New repository secret** をクリック
3. 以下を登録:

| Name | 値 |
|---|---|
| `OPENAI_API_KEY` | `sk-...`（OpenAI の API キー） |

> `SCAN_TARGET_TOKEN` は今回不要。最初は public repo でテストする。

---

## ステップ 2: ワークフローを手動実行

1. **Actions** タブをクリック
2. 左サイドバーの **Security Scan** をクリック
3. **Run workflow** ボタン（右側）をクリック
4. ドロップダウンが開くので入力:
   - **Branch**: `develop`
   - **スキャン対象リポジトリ**: `tecokimura/repo-sentry`
5. 緑の **Run workflow** ボタンをクリック

> 最初のテストは repo-sentry 自身を対象にする。
> public リポジトリなのでトークン不要で clone できる。

---

## ステップ 3: 実行中のログを確認

1. ページを更新するとジョブが表示される
2. ジョブ名 **scan-and-report** をクリック
3. 各ステップをクリックするとログがリアルタイムで流れる

正常に進むとこう見える:

```
✅ repo-sentry をチェックアウト       (約10秒)
✅ 必須 Secret の確認                (約5秒)
✅ Docker Buildx セットアップ         (約10秒)
✅ scan image をビルド               (初回 5〜10分 / 2回目以降 1〜2分)
✅ enrich image をビルド             (初回 1〜2分 / 2回目以降 数秒)
✅ report image をビルド             (初回 1〜2分 / 2回目以降 数秒)
✅ export image をビルド             (初回 3〜5分 / 2回目以降 1分)
✅ スキャン対象リポジトリを clone      (約15秒)
✅ scan → enrich → report を実行     (5〜15分)
✅ PDF を生成                        (1〜3分)
✅ 成果物をアップロード               (約30秒)
```

> scan image のビルドは gitleaks と trivy のダウンロードがあるため初回は時間がかかる。
> 2回目以降はキャッシュが効いて大幅に短縮される。

---

## ステップ 4: 成果物を確認

ジョブが完了したら:

1. ジョブ画面を下にスクロール → **Artifacts** セクション
2. **security-report-XXXXXXXX** をクリックして zip をダウンロード
3. zip を展開して中身を確認:

```
security-report-XXXXXXXX/
  reports/
    repo-sentry-develop/
      scan_reposen_XXXX.json
      scan_reposen_XXXX.sbom.cdx.json
      enriched_reposen_XXXX.json
      report_reposen_XXXX-plan.json
      report_reposen_XXXX.md
      report_reposen_XXXX.pdf       ← 開けるか確認
  logs/
    repo-sentry-develop/
      run_XXXXXX.log
```

確認すること:
- `report_*.pdf` をダブルクリックして開ける（文字化けなし・内容あり）
- `report_*.md` をテキストエディタで開いて内容がある
- `logs/` フォルダがある

---

## 失敗した場合

失敗したステップは赤い **✗** で表示される。ステップをクリックしてログの末尾を確認する。

| 失敗したステップ | ログのメッセージ | 対処 |
|---|---|---|
| 必須 Secret の確認 | `OPENAI_API_KEY が設定されていません` | Secrets に `OPENAI_API_KEY` を登録 |
| clone | `Repository not found` | `target_repo` の入力ミス |
| clone | `Authentication failed` | private repo → `SCAN_TARGET_TOKEN` を登録 |
| scan → enrich → report | `Unauthorized` / `LLM error` | `OPENAI_API_KEY` の値が間違い・残高不足 |

---

## 確認完了の基準

以下が全部 OK なら **GitHub Actions 初期版は完了**:

- [ ] 全ステップが緑
- [ ] Artifacts の zip がダウンロードできる
- [ ] `report_*.pdf` が開ける
- [ ] `logs/` フォルダがある

---

## 確認完了後: private リポジトリを試す場合

1. Secrets に `SCAN_TARGET_TOKEN`（`repo` スコープの PAT）を登録
2. `target_repo` にプライベートリポジトリの `owner/repo` を入力して再実行

---

## 関連ファイル

| ファイル | 内容 |
|---|---|
| `.github/workflows/security-scan.yml` | ワークフロー本体 |
| `scripts/docker-run.sh` | scan → enrich → report 一括実行 |
| `scripts/docker-export.sh` | report.md → PDF 変換 |
| `scripts/docker-build.sh` | 4イメージ一括ビルド（ローカル用） |
| `docs/phase.md` | 全体ロードマップ・設計方針 |
