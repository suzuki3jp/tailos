import { AccountPage } from "@/_pages/account";
import { Home } from "./home";
import { LegacyLayout } from "@/app/legacy-layout";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  if (error)
    return (
      <LegacyLayout>
        <AccountPage error={error} />
      </LegacyLayout>
    );
  return <Home />;
}
