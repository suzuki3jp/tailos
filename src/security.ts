export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret.length > 5) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT REDACTED]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[GITHUB TOKEN REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, /token|password|secret|authorization|verifier|device_auth_id/i.test(key) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}
export function safeError(error: unknown): string {
  return String(redact(error instanceof Error ? error.message : String(error))).slice(0, 500);
}
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
export async function readLimitedText(request: Request, limit: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Request body is too large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
