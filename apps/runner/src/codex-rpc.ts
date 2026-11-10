import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import * as v from "valibot";

export type CodexProcess = ChildProcessByStdio<Writable, Readable, null>;

const messageSchema = v.object({
  id: v.optional(v.union([v.number(), v.string()])),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class CodexRpc {
  private readonly child: CodexProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private failure?: Error;
  onNotification: (method: string, params: unknown) => void = () => {};
  onRequest: (method: string, params: unknown) => Promise<unknown> =
    async () => {
      throw new Error("Unsupported request");
    };
  onFailure: (error: Error) => void = () => {};

  constructor(child: CodexProcess) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) =>
      this.receive(line),
    );
    child.once("error", () =>
      this.fail(new Error("Codex app-server could not start")),
    );
    child.once("exit", () => this.fail(new Error("Codex app-server stopped")));
    child.stdin.on("error", () =>
      this.fail(new Error("Codex app-server input closed")),
    );
  }

  private receive(line: string) {
    try {
      const message = v.parse(messageSchema, JSON.parse(line));
      if (message.method && message.id !== undefined) {
        const id = message.id;
        void this.onRequest(message.method, message.params)
          .then(
            (result) => this.send({ id, result }),
            () =>
              this.send({
                id,
                error: { code: -32000, message: "Request unavailable" },
              }),
          )
          .catch(() => this.fail(new Error("Could not answer app-server")));
        return;
      }
      if (message.method) {
        this.onNotification(message.method, message.params);
        return;
      }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined)
        request.reject(new Error("Codex app-server rejected a request"));
      else request.resolve(message.result);
    } catch {
      this.fail(new Error("Invalid app-server response"));
    }
  }

  private send(message: unknown) {
    if (!this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  notify(method: string) {
    this.send({ method });
  }

  call(method: string, params: unknown) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex app-server request timed out"));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  close() {
    this.fail(new Error("Codex app-server closed"));
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
  }
}
