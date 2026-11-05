import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../internal.ts";
import type { CodexAccess } from "@meguri/core/runner";
import {
  CodexDeviceAuth,
  ReauthenticationRequired,
  codexCredentialsSchema,
  type CodexCredentials,
} from "./codex-device.ts";
import {
  TransientDevicePollError,
  type DeviceAuthAdapter,
  type ConnectionStatus,
  type DeviceChallenge,
} from "./device.ts";
import { seal, unseal, type Sealed } from "./sealed-store.ts";
import * as v from "valibot";

const pendingContext = "meguri:codex:default:pending:v1";
const credentialContext = "meguri:codex:default:credentials:v1";

const pendingSchema = v.strictObject({
  id: v.string(),
  userCode: v.string(),
  verificationUrl: v.literal("https://auth.openai.com/codex/device"),
  intervalMs: v.number(),
  expiresAt: v.number(),
});

type StoredConnection = {
  version: string;
  accessVersion?: string;
  value: Sealed;
};

export class CredentialBroker extends DurableObject<Bindings> {
  protected readonly adapter: DeviceAuthAdapter<CodexCredentials> =
    new CodexDeviceAuth();

  private get key() {
    const key = this.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!key) throw new Error("Missing encryption key");
    return key;
  }

  private async readPending(): Promise<DeviceChallenge | null> {
    const record = await this.ctx.storage.get<Sealed>("pending");
    if (!record) return null;
    return v.parse(
      pendingSchema,
      await unseal(record, this.key, pendingContext),
    );
  }

  async status(): Promise<ConnectionStatus> {
    if (await this.ctx.storage.get("connection")) return { state: "connected" };
    const pending = await this.readPending();
    if (pending) {
      if (Date.now() >= pending.expiresAt) return { state: "expired" };
      return {
        state: "pending",
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrl,
      };
    }
    const state = await this.ctx.storage.get<
      "connected" | "expired" | "failed"
    >("status");
    return { state: state ?? "disconnected" };
  }

  async begin(): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("connection")) return false;
      const existing = await this.readPending().catch(async () => {
        await this.finish("failed");
        return null;
      });
      if (existing && existing.expiresAt > Date.now()) {
        if ((await this.ctx.storage.getAlarm()) === null)
          await this.ctx.storage.setAlarm(Date.now() + existing.intervalMs);
        return true;
      }
      const previous = (await this.ctx.storage.get<number>("lastStarted")) ?? 0;
      if (Date.now() - previous < 15_000) return false;
      await this.ctx.storage.put("lastStarted", Date.now());

      try {
        const challenge = await this.adapter.begin();
        await this.ctx.storage.put(
          "pending",
          await seal(challenge, this.key, pendingContext),
        );
        await this.ctx.storage.setAlarm(Date.now() + challenge.intervalMs);
        return true;
      } catch {
        await this.finish("failed");
        return false;
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.delete(["connection", "pending", "status"]);
      await this.ctx.storage.deleteAlarm();
    });
  }

  async issueAccess(rejected?: {
    connectionVersion: string;
    accessVersion: string;
  }): Promise<CodexAccess | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const connection =
        await this.ctx.storage.get<StoredConnection>("connection");
      if (
        !connection ||
        (rejected && rejected.connectionVersion !== connection.version)
      )
        return null;
      let accessVersion = connection.accessVersion ?? connection.version;
      let creds = v.parse(
        codexCredentialsSchema,
        await unseal(connection.value, this.key, credentialContext),
      );
      if (
        rejected?.accessVersion === accessVersion ||
        creds.expiresAt <= Date.now() + 60_000
      ) {
        try {
          creds = await this.adapter.refresh(creds);
        } catch (error) {
          if (!(error instanceof ReauthenticationRequired)) throw error;
          await this.ctx.storage.transaction(async (storage) => {
            await storage.delete("connection");
            await storage.put("status", "failed");
          });
          return null;
        }
        accessVersion = crypto.randomUUID();
        await this.ctx.storage.put("connection", {
          version: connection.version,
          accessVersion,
          value: await seal(creds, this.key, credentialContext),
        } satisfies StoredConnection);
      }
      return {
        accessToken: creds.accessToken,
        accountId: creds.accountId,
        planType: creds.planType,
        connectionVersion: connection.version,
        accessVersion,
      };
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const pending = await this.readPending().catch(async () => {
        await this.finish("failed");
        return null;
      });
      if (!pending) return;
      if (Date.now() >= pending.expiresAt) {
        await this.finish("expired");
        return;
      }

      let credentials;
      try {
        credentials = await this.adapter.complete(pending);
      } catch (error) {
        if (error instanceof TransientDevicePollError) {
          await this.ctx.storage.setAlarm(
            Math.min(pending.expiresAt, Date.now() + pending.intervalMs * 2),
          );
        } else {
          await this.finish("failed");
        }
        return;
      }

      if (!credentials) {
        await this.ctx.storage.setAlarm(
          Math.min(pending.expiresAt, Date.now() + pending.intervalMs),
        );
        return;
      }
      const connection = {
        version: crypto.randomUUID(),
        value: await seal(credentials, this.key, credentialContext),
      };
      await this.ctx.storage.transaction(async (storage) => {
        await storage.put({ connection, status: "connected" });
        await storage.delete("pending");
      });
    });
  }

  private async finish(state: "expired" | "failed") {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.delete("pending");
      await storage.put("status", state);
    });
  }
}
