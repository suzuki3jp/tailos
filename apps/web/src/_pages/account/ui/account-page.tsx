import { Account } from "./account";

export function AccountPage({ error }: { error?: string | string[] }) {
  return (
    <section className="max-w-lg space-y-5">
      <h1 className="text-3xl font-medium">アカウント</h1>
      <p className="text-muted">
        GitHub でログインして、Agent の接続と Session の実行結果を確認できます。
      </p>
      <div className="surface space-y-4">
        {error && (
          <p role="alert" className="text-danger">
            ログインできませんでした。
          </p>
        )}
        <Account />
      </div>
    </section>
  );
}
