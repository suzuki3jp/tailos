export type DeviceChallenge = {
  id: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
};

export interface DeviceAuthAdapter<Credentials> {
  begin(): Promise<DeviceChallenge>;
  complete(challenge: DeviceChallenge): Promise<Credentials | null>;
}

export const defaultCodexConnection = "codex/default";

export type ConnectionStatus =
  | { state: "disconnected" | "connected" | "expired" | "failed" }
  | { state: "pending"; userCode: string; verificationUrl: string };

export interface ConnectionControl {
  status(): Promise<ConnectionStatus>;
  begin(): Promise<boolean>;
  disconnect(): Promise<void>;
}
