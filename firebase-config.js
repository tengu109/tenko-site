// firebase-config.js
// ------------------------------------------------------------
// Firebaseプロジェクトの「設定値」だけを持つファイルです。
// Firebaseコンソール → プロジェクトの設定 → 全般 → マイアプリ（ウェブアプリ）
// の「SDK の設定と構成」に表示される値をここに貼り付けてください。
//
// ※ ここに書く値はクライアント（ブラウザ）に公開される情報で、
//    秘密鍵ではありません。実際のアクセス制御は
//    Firestore のセキュリティルール側で行います
//    （README.md の「Firestoreセキュリティルール」を参照）。
// ------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
