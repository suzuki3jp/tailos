import { AccountPage } from "@/_pages/account";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return <AccountPage error={error} />;
}
