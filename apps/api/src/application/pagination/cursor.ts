/** The wire format shared by list endpoints. Each endpoint owns its payload. */
export function encodePageCursor(position: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodePageCursor(cursor: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
  const bytes = Uint8Array.from(
    atob(cursor.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
