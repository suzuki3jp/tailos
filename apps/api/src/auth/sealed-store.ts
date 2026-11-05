export type Sealed = { iv: string; ciphertext: string };
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));

async function importKey(encoded: string, usage: "encrypt" | "decrypt") {
  const raw = decode(encoded);
  if (raw.length !== 32)
    throw new Error("Expected a 32-byte credential encryption key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

export async function seal(
  value: unknown,
  encodedKey: string,
  context: string,
): Promise<Sealed> {
  const key = await importKey(encodedKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function unseal(
  value: Sealed,
  encodedKey: string,
  context: string,
): Promise<unknown> {
  const key = await importKey(encodedKey, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(value.iv),
      additionalData: encoder.encode(context),
    },
    key,
    decode(value.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
