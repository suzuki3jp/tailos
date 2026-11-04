export interface Sealed { iv: string; ciphertext: string }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
export async function seal(value: unknown, encodedKey: string, context: string): Promise<Sealed> {
  const raw = decode(encodedKey);
  if (raw.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unseal<T>(value: Sealed, encodedKey: string, context: string): Promise<T> {
  const key = await crypto.subtle.importKey('raw', decode(encodedKey), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv), additionalData: new TextEncoder().encode(context) }, key, decode(value.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
