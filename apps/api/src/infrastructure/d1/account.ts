import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users } from "./schema.ts";

export async function readAccountProfile(db: D1Database, userId: string) {
  const [profile] = await drizzle(db)
    .select({ name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(eq(users.id, userId));
  return profile ?? null;
}
