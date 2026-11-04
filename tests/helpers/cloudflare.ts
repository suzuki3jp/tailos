// A storage/scheduling test double; not a substitute for a deployed Cloudflare smoke test.
export class DurableObject {
  protected ctx: any;
  protected env: any;
  constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; }
}
export function memoryState() {
  const map = new Map<string, any>();
  let alarm: number | null = null;
  let queue = Promise.resolve();
  return {
    map,
    blockConcurrencyWhile<T>(action: () => Promise<T>): Promise<T> {
      const result = queue.then(action); queue = result.then(() => {}, () => {}); return result;
    },
    storage: {
      async get<T>(key: string): Promise<T | undefined> { return structuredClone(map.get(key)); },
      async put(key: string | Record<string, any>, value?: any) {
        if (typeof key === 'string') map.set(key, structuredClone(value));
        else for (const [k, v] of Object.entries(key)) map.set(k, structuredClone(v));
      },
      async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
      async list(options: { prefix: string }) { return new Map([...map.entries()].filter(([k]) => k.startsWith(options.prefix)).map(([k, v]) => [k, structuredClone(v)])); },
      async setAlarm(time: number) { alarm = time; },
      async getAlarm() { return alarm; },
      async deleteAlarm() { alarm = null; },
    },
  };
}
