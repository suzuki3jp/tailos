export async function validSignature(
  secret: string,
  header: string | undefined,
  body: ArrayBuffer,
) {
  if (!header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const signature = Uint8Array.from(
    header.slice(7).match(/../g) ?? [],
    (byte) => parseInt(byte, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}
