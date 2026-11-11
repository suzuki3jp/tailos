import { Account } from "@/app/login/account";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <section className="max-w-lg space-y-5">
      <h1 className="text-3xl font-medium">アカウント</h1>
      <p className="text-muted">
        GitHub でログインして、ChatGPT 接続と Session の実行結果を確認できます。
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
