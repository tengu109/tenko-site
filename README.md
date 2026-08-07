# TENKO！ 小天狗出欠調整サイト

練習・本番の出欠とお当番を管理するチーム向けアプリです。
Cloud Firestore をバックエンドにしたリアルタイム同期対応・PWA（ホーム画面に追加できるアプリ）構成になっています。

## ファイル構成

```
tenko-app/
├── index.html          … 画面のHTML（デザイン・UIは変更していません）
├── style.css            … スタイル
├── app.js                … アプリのロジック本体（Firestore連携・画面描画すべて）
├── firebase-config.js    … Firebaseの接続設定だけを書くファイル（★ここを書き換えます）
├── manifest.json          … PWA設定
├── sw.js                   … サービスワーカー（オフラインでもアプリの画面が開けるようにする）
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── vercel.json             … Vercelへデプロイする際の細かい設定
└── .gitignore
```

---

## 1. Firebaseプロジェクトを作る

1. https://console.firebase.google.com/ にアクセスし、「プロジェクトを追加」
2. プロジェクト名を入力（例：`tenko-app`）して作成
3. 左メニューの「構築」→「Firestore Database」→「データベースの作成」
   - ロケーションは `asia-northeast1`（東京）がおすすめ
   - 最初は「本番環境モード」を選択（下記のセキュリティルールをそのまま貼り付ければ動きます）
4. 左メニューの「プロジェクトの概要」→ 歯車アイコン →「プロジェクトの設定」
5. 下の方の「マイアプリ」で「ウェブアプリを追加」（`</>` アイコン）
6. アプリ名を入力して登録すると、`firebaseConfig` という値一式が表示されます

## 2. `firebase-config.js` を書き換える

`firebase-config.js` を開き、Firebaseコンソールに表示された値をそのまま貼り付けます。

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "tenko-app-xxxx.firebaseapp.com",
  projectId: "tenko-app-xxxx",
  storageBucket: "tenko-app-xxxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:xxxxxxxxxx"
};
```

※ この値はブラウザに公開される情報で、秘密鍵ではありません。実際のアクセス制御は次のFirestoreセキュリティルールで行います。

## 3. Firestoreセキュリティルール

Firebaseコンソール → Firestore Database →「ルール」タブに、以下を貼り付けて「公開」してください。
このアプリは1つのコレクション（`tenko`）だけを使う設計なので、ルールもシンプルです。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenko/{docId} {
      allow read, write: if true;
    }
  }
}
```

**重要な注意点**：このアプリの「管理者モード」のパスコードは、あくまで画面上の操作を制限するだけの仕組みです。上記のルールは「このFirestoreのURLを知っている人なら誰でも読み書きできる」状態になります。身内・チーム内だけで使う分には現実的な設定ですが、より厳密に守りたい場合は、Firebase Authenticationを追加してルールを `if request.auth != null` のように変更することをおすすめします（今回の実装範囲には含まれていません）。

## 4. ローカルで動作確認する

このアプリは `type="module"` を使っているため、`index.html` をブラウザで直接ダブルクリックして開くだけでは動きません（CORSの制限）。簡易サーバーを立てて確認してください。

```bash
# Python がある場合
cd tenko-app
python3 -m http.server 8000
# → http://localhost:8000 にアクセス

# Node.js がある場合
npx serve tenko-app
```

## 5. GitHubにアップロードする

```bash
cd tenko-app
git init
git add .
git commit -m "TENKO! initial commit"
git branch -M main
git remote add origin https://github.com/あなたのアカウント/tenko-app.git
git push -u origin main
```

## 6. Vercelへデプロイする

1. https://vercel.com/ にログイン（GitHubアカウントでOK）
2. 「Add New...」→「Project」
3. 先ほどpushしたGitHubリポジトリを選択して「Import」
4. Framework Presetは自動判定されない場合「Other」を選択（ビルド不要の静的サイトです。Build Command・Output Directoryは空欄のままでOK）
5. 「Deploy」を押すと数十秒で公開されます

以後は `main` ブランチにpushするたびに自動で再デプロイされます。

## 7. PWAとして使う

デプロイ後のURLをスマートフォンのブラウザ（Chrome / Safari）で開き、
- Android: メニューから「ホーム画面に追加」
- iPhone: 共有ボタンから「ホーム画面に追加」

を選ぶと、アプリのように起動できるアイコンが追加されます。

---

## 今回の変更点まとめ

| 項目 | 内容 |
|---|---|
| ① Firestore移行 | `window.storage` を廃止し、すべてのデータ（名簿・保護者・イベント・出欠・お当番・場所・バッジ・年度アーカイブ等）を Cloud Firestore に保存するよう変更 |
| ② リアルタイム同期 | 各データに `onSnapshot` を設定し、他の端末での変更が自動的に画面へ反映されるように変更 |
| ③ PWA対応 | `manifest.json` ・ `sw.js` ・アイコンを追加し、ホーム画面への追加とオフラインでのアプリ起動に対応 |
| ④ デプロイ構成 | 単一HTMLから `index.html` / `style.css` / `app.js` に分割し、GitHub→Vercelにそのままデプロイできる静的サイト構成に整理 |
| ⑤ Firebase設定分離 | 接続情報のみを `firebase-config.js` に切り出し |
| ⑥ README | このファイル |

デザイン・UI・既存の機能はすべてそのまま、データの保存先とリアルタイム性だけを本番運用向けに強化しています。
