# 早押しピンポン

親が出題者、子が回答者になって遊ぶ早押しクイズのボタンアプリです。
各スマホでページを開き、同じルーム番号で入ります。

- 子が押した順番がサーバーに届いた順で決まり、親の画面に並びます
- 親が「〇〇さんに解答権」をタップすると、その子の画面が光って音が鳴ります
- ⭕で得点、❌でその子はその問題お休み（ほかの子に解答権を渡せます）
- 出題者画面の「参加用QRを表示」で、ルーム番号入りの参加QRが出ます

## しくみ

| ファイル | 役割 |
| --- | --- |
| `public/index.html` | 画面（出題者・回答者とも同じページ） |
| `src/index.js` | Cloudflare Worker。`/ws/<ルーム番号>` の WebSocket をルームごとの Durable Object につなぐ |
| `wrangler.jsonc` | Cloudflare の設定（Worker 名 `online-test`） |

## Cloudflare への公開（GitHub 連携）

1. Cloudflare ダッシュボードの **Workers & Pages** を開く
2. **Create application** を押し、**GitHub** を選ぶ（初回は GitHub の認証）
3. このリポジトリを選ぶ
4. 設定はそのままで **Save and Deploy**
   - プロジェクト名は `online-test`（`wrangler.jsonc` の `name` と同じ）
   - デプロイコマンドは `npx wrangler deploy`
5. `https://online-test.mitsumedia000.workers.dev` で開ける

以後は GitHub の main ブランチに push するたびに自動で更新されます。

## 手元で動かす

```
npm install
npm run dev
```
