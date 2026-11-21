import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { TimelineClientMessage } from "@tailos/core/timeline";
import type { Bindings } from "@/bindings.ts";
import { d1Timeline } from "@/infrastructure/d1/timeline.ts";

const subscriptionSchema = v.object({
  sessionId: v.string(),
  ownerId: v.string(),
  loginId: v.string(),
  projectId: v.optional(v.string()),
  cursor: v.number(),
  frames: v.optional(
    v.array(v.object({ cursor: v.number(), bytes: v.number() })),
    [],
  ),
});
type Subscription = v.InferOutput<typeof subscriptionSchema>;

// This object never starts a container and stores no login tokens or bodies.
export class SessionStream extends DurableObject<Bindings> {
  private readonly pending = new Map<WebSocket, Promise<void>>();
  private readonly depths = new Map<WebSocket, number>();

  private async authorized(subscription: Subscription) {
    return Boolean(
      await this.env.DB.prepare(`SELECT l.id FROM login_sessions l JOIN sessions s ON s.owner_id = l.user_id
      WHERE l.id = ? AND l.user_id = ? AND l.expires_at > ? AND s.id = ? AND (? IS NULL OR s.project_id = ?)
      AND EXISTS (SELECT 1 FROM auth_accounts a WHERE a.user_id = l.user_id AND a.provider_id = 'github' AND a.account_id = ?)`)
        .bind(
          subscription.loginId,
          subscription.ownerId,
          Date.now(),
          subscription.sessionId,
          subscription.projectId ?? null,
          subscription.projectId ?? null,
          this.env.TAILOS_OPERATOR_GITHUB_ID ?? "",
        )
        .first(),
    );
  }

  async fetch(request: Request) {
    const subscription: Subscription = {
      sessionId: request.headers.get("X-Tailos-Session") ?? "",
      ownerId: request.headers.get("X-Tailos-Owner") ?? "",
      loginId: request.headers.get("X-Tailos-Login") ?? "",
      projectId: request.headers.get("X-Tailos-Project") ?? undefined,
      cursor: 0,
      frames: [],
    };
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    if (!(await this.authorized(subscription)))
      return new Response(null, { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [subscription.sessionId]);
    server.serializeAttachment(subscription);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  private enqueue(socket: WebSocket, action: () => Promise<void>) {
    const depth = this.depths.get(socket) ?? 0;
    if (depth >= 8) {
      socket.close(1013, "Subscriber is too slow");
      return Promise.resolve();
    }
    this.depths.set(socket, depth + 1);
    const task = (this.pending.get(socket) ?? Promise.resolve())
      .then(action)
      .catch(() => {
        try {
          socket.close(1011, "Stream unavailable");
        } catch {
          /* Already closed. */
        }
      });
    this.pending.set(socket, task);
    void task.finally(() => {
      const remaining = (this.depths.get(socket) ?? 1) - 1;
      if (remaining) this.depths.set(socket, remaining);
      else this.depths.delete(socket);
      if (this.pending.get(socket) === task) this.pending.delete(socket);
    });
    return task;
  }

  private async send(socket: WebSocket) {
    const subscription = v.parse(
      subscriptionSchema,
      socket.deserializeAttachment(),
    );
    if (!(await this.authorized(subscription))) {
      socket.close(1008, "Authentication expired");
      return;
    }
    const reader = d1Timeline(this.env.DB);
    // A slow subscriber catches up using a fresh snapshot instead of building
    // an unbounded send queue. Output bodies are never broadcast.
    for (let page = 0; page < 5; page++) {
      const changes = await reader.changes(
        subscription.sessionId,
        subscription.cursor,
      );
      if (!changes) {
        socket.send(JSON.stringify({ type: "reset_required" }));
        return;
      }
      if (changes.cursor !== subscription.cursor) {
        const encoded = JSON.stringify(changes);
        const bytes = new TextEncoder().encode(encoded).byteLength;
        if (
          subscription.frames.length >= 8 ||
          subscription.frames.reduce((sum, frame) => sum + frame.bytes, bytes) >
            1024 * 1024
        )
          break;
        socket.send(encoded);
        subscription.cursor = changes.cursor;
        subscription.frames.push({ cursor: changes.cursor, bytes });
        socket.serializeAttachment(subscription);
      }
      if (!changes.hasMore) return;
    }
    socket.send(JSON.stringify({ type: "reset_required" }));
    socket.close(1013, "Refresh snapshot");
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 1024) {
      socket.close(1009, "Invalid message");
      return;
    }
    let parsed;
    try {
      parsed = v.safeParse(TimelineClientMessage, JSON.parse(message));
    } catch {
      socket.close(1008, "Invalid message");
      return;
    }
    if (!parsed.success) {
      socket.close(1008, "Unsupported message");
      return;
    }
    const command = parsed.output;
    await this.enqueue(socket, async () => {
      const subscription = v.parse(
        subscriptionSchema,
        socket.deserializeAttachment(),
      );
      if (!(await this.authorized(subscription))) {
        socket.close(1008, "Authentication expired");
        return;
      }
      if (command.type === "resume") {
        subscription.cursor = command.after;
        subscription.frames = [];
        socket.serializeAttachment(subscription);
      } else if (command.type === "ack") {
        if (command.cursor > subscription.cursor) {
          socket.close(1008, "Invalid acknowledgement");
          return;
        }
        subscription.frames = subscription.frames.filter(
          (frame) => frame.cursor > command.cursor,
        );
        socket.serializeAttachment(subscription);
        return;
      } else socket.send(JSON.stringify({ type: "pong" }));
      await this.send(socket);
    });
  }

  async notify(sessionId: string) {
    await Promise.all(
      this.ctx
        .getWebSockets(sessionId)
        .map((socket) => this.enqueue(socket, () => this.send(socket))),
    );
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      const subscription = v.safeParse(
        subscriptionSchema,
        socket.deserializeAttachment(),
      );
      if (
        !subscription.success ||
        !(await this.authorized(subscription.output))
      )
        socket.close(1008, "Authentication expired");
    }
    if (this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  webSocketClose(socket: WebSocket, code: number) {
    socket.close(
      code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)
        ? code
        : 1000,
    );
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, "Connection error");
  }
}

export async function deliverTimelineNotifications(
  env: Bindings,
  runId?: string,
) {
  if (!env.SESSION_STREAM) return;
  const query = runId
    ? env.DB.prepare(`SELECT n.session_id AS sessionId, n.version FROM runs r
        JOIN session_activity_notifications n ON n.session_id = r.session_id
        WHERE r.id = ? AND n.version > n.delivered_version`).bind(runId)
    : env.DB
        .prepare(`SELECT session_id AS sessionId, version FROM session_activity_notifications
        WHERE version > delivered_version LIMIT 50`);
  const rows = await query.all<{ sessionId: string; version: number }>();
  for (const row of rows.results) {
    try {
      await env.SESSION_STREAM.getByName(row.sessionId).notify(row.sessionId);
      await env.DB.prepare(
        `UPDATE session_activity_notifications SET delivered_version = max(delivered_version, ?) WHERE session_id = ?`,
      )
        .bind(row.version, row.sessionId)
        .run();
    } catch {
      // The durable outbox is retried by Cron; no body or credential is logged.
    }
  }
}
