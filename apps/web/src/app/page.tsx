import { AccountPage } from "@/_pages/account";
import { HomePage as Home } from "@/_pages/home";
import { LegacyLayout } from "@/app/legacy-layout";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return error ? (
    <LegacyLayout>
      <AccountPage error={error} />
    </LegacyLayout>
  ) : (
    <Home />
  );
}
