import {
  diagnosticBatchSchema,
  maxDiagnosticBatch,
  maxDiagnosticBody,
  maxDiagnosticBytes,
  maxDiagnosticEvents,
  type Diagnostics,
  type DiagnosticAttributes,
  type DiagnosticBatch,
  type DiagnosticRecord,
} from "@tailos/core/diagnostics";
import type { RunnerJob } from "@tailos/core/runner";
import { redactDiagnosticBody } from "@tailos/diagnostics";
import * as v from "valibot";

export class RunnerDiagnostics implements Diagnostics {
  private readonly context;
  private readonly secrets = new Set<string>();
  private readonly queue: DiagnosticRecord[] = [];
  private readonly operations = new Map<
    string,
    {
      operation: DiagnosticAttributes["operation"];
      startedAt: number;
      parentSpanId: string;
    }
  >();
  private work = Promise.resolve();
  private sending?: Promise<void>;
  private packet?: { body: string; count: number };
  private seq = 0;
  private dropped = 0;
  private reservedBytes = 0;
  private totalBytes = 0;
  private closed = false;
  private parentSpanId?: string;
  private readonly timer?: ReturnType<typeof setInterval>;

  constructor(
    job: RunnerJob,
    private readonly http: typeof fetch = fetch,
    private readonly requestId?: string,
  ) {
    this.context = job.diagnostics;
    this.parentSpanId = job.diagnostics?.parentSpanId;
    if (job.engine === "codex") {
      this.addSecret(job.access.accessToken);
      this.addSecret(job.refresh.bearer);
      if (job.checkout) {
        this.addSecret(job.checkout.token);
        this.addSecret(
          Buffer.from(`x-access-token:${job.checkout.token}`).toString(
            "base64",
          ),
        );
      }
    }
    if (this.context) {
      this.addSecret(this.context.bearer);
      this.timer = setInterval(() => {
        void this.flush();
      }, 1_500);
      this.timer.unref();
    }
  }

  addSecret(secret: string) {
    if (secret) this.secrets.add(secret);
  }

  setParentSpan(spanId: string) {
    this.parentSpanId = spanId;
  }

  start(
    operation: NonNullable<DiagnosticAttributes["operation"]>,
    body?: string,
    parentSpanId?: string,
  ) {
    const spanId = crypto.randomUUID();
    if (!this.context) return spanId;
    if (this.operations.size < maxDiagnosticEvents)
      this.operations.set(spanId, {
        operation,
        startedAt: performance.now(),
        parentSpanId:
          parentSpanId ?? this.parentSpanId ?? this.context.parentSpanId,
      });
    this.record(spanId, "span.started", { operation }, body, parentSpanId);
    return spanId;
  }

  end(spanId: string, attributes: DiagnosticAttributes = {}, body?: string) {
    const operation = this.operations.get(spanId);
    this.operations.delete(spanId);
    this.record(
      spanId,
      "span.finished",
      {
        operation: operation?.operation,
        durationMs: operation
          ? performance.now() - operation.startedAt
          : undefined,
        outcome: "succeeded",
        ...attributes,
      },
      body,
      operation?.parentSpanId,
    );
  }

  output(spanId: string, body: string) {
    this.record(
      spanId,
      "output",
      {},
      body,
      this.operations.get(spanId)?.parentSpanId,
    );
  }

  private record(
    spanId: string,
    name: DiagnosticRecord["name"],
    attributes: DiagnosticAttributes,
    input?: string,
    parentSpanId?: string,
  ) {
    if (!this.context || this.closed) return;
    if (
      this.seq >= maxDiagnosticEvents ||
      this.reservedBytes >= 4 * 1024 * 1024
    ) {
      this.dropped++;
      return;
    }
    let body = input;
    const bytes = input === undefined ? 0 : Buffer.byteLength(input);
    if (
      bytes > maxDiagnosticBody ||
      this.totalBytes + bytes > maxDiagnosticBytes
    ) {
      body = undefined;
      this.dropped++;
      attributes = { ...attributes, reason: "limit" };
    }
    this.totalBytes += body === undefined ? 0 : bytes;
    const reservation =
      (body === undefined ? 0 : Math.min(bytes * 10, maxDiagnosticBody)) + 1024;
    this.reservedBytes += reservation;
    const record: DiagnosticRecord = {
      eventId: crypto.randomUUID(),
      spanId,
      parentSpanId:
        parentSpanId ?? this.parentSpanId ?? this.context.parentSpanId,
      seq: ++this.seq,
      at: Date.now(),
      name,
      attributes,
      ...(this.requestId && { requestId: this.requestId }),
    };
    this.work = this.work.then(async () => {
      try {
        if (body !== undefined)
          record.body = await redactDiagnosticBody(body, this.secrets);
        if (
          record.body !== undefined &&
          (Buffer.byteLength(record.body) > maxDiagnosticBody ||
            Buffer.byteLength(JSON.stringify(record)) >
              maxDiagnosticBatch - 1024)
        ) {
          delete record.body;
          record.attributes = { ...attributes, reason: "limit" };
          this.dropped++;
        }
      } catch {
        this.dropped++;
        record.attributes = { ...attributes, reason: "redaction" };
      }
      this.queue.push(record);
      // The reservation is retained until ACK to bound both raw and sanitized queues.
    });
  }

  async flush(budgetMs = 3_000) {
    if (!this.context) return;
    await this.work;
    if (this.sending) return this.sending;
    const deadline = Date.now() + budgetMs;
    this.sending = this.drain(deadline).finally(() => {
      this.sending = undefined;
    });
    await this.sending;
  }

  private async drain(deadline: number) {
    if (!this.context) return;
    while (this.queue.length && Date.now() < deadline) {
      if (!this.packet) {
        const records: DiagnosticRecord[] = [];
        let bytes = 1024;
        for (const record of this.queue.slice(0, 32)) {
          const next = Buffer.byteLength(JSON.stringify(record));
          if (bytes + next > maxDiagnosticBatch) break;
          bytes += next;
          records.push(record);
        }
        this.packet = {
          body: JSON.stringify({
            version: 1,
            batchId: crypto.randomUUID(),
            producerId: this.context.producerId,
            records,
          } satisfies DiagnosticBatch),
          count: records.length,
        };
      }
      if (!(await this.send(this.packet.body, deadline))) return;
      this.queue.splice(0, this.packet.count);
      this.packet = undefined;
      this.reservedBytes = this.queue.reduce(
        (total, record) =>
          total +
          1024 +
          (record.body === undefined ? 0 : Buffer.byteLength(record.body)),
        0,
      );
    }
  }

  private async send(body: string, deadline: number) {
    if (
      !this.context ||
      Date.now() >= deadline ||
      Date.now() >= this.context.expiresAt
    )
      return false;
    try {
      const url = new URL(this.context.url);
      if (url.protocol !== "https:" || url.username || url.password)
        return false;
      // Validate before sending; failures never serialize the rejected input.
      v.parse(diagnosticBatchSchema, JSON.parse(body));
      const response = await this.http(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.context.bearer}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(3_000, deadline - Date.now())),
        ),
      });
      await response.body?.cancel();
      return response.status === 204;
    } catch {
      return false;
    }
  }

  async finish() {
    if (this.timer) clearInterval(this.timer);
    if (!this.context || this.closed) return;
    this.dropped += this.operations.size;
    this.operations.clear();
    this.closed = true;
    await this.flush();
    if (this.queue.length) return; // Missing final marker is explicitly unknown, not complete.
    const batch: DiagnosticBatch = {
      version: 1,
      batchId: crypto.randomUUID(),
      producerId: this.context.producerId,
      records: [],
      completed: { lastSeq: this.seq, dropped: this.dropped },
    };
    await this.send(JSON.stringify(batch), Date.now() + 1_000);
  }
}
