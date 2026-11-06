export type SessionStore<Detail> = {
  create(input: {
    id: string;
    ownerId: string;
    createdAt: number;
    messages: {
      id: string;
      sessionId: string;
      authorKind: "user";
      body: string;
      seq: number;
      createdAt: number;
    }[];
  }): Promise<void>;
  read(id: string, ownerId: string): Promise<Detail | null>;
};

export async function createSession(
  store: Pick<SessionStore<unknown>, "create">,
  ownerId: string,
  bodies: string[],
) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await store.create({
    id,
    ownerId,
    createdAt,
    messages: bodies.map((body, index) => ({
      id: crypto.randomUUID(),
      sessionId: id,
      authorKind: "user",
      body,
      seq: index + 1,
      createdAt,
    })),
  });
  return id;
}
