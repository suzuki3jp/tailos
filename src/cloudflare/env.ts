import type { CredentialBroker } from './credential-broker';
import type { ControlPlane } from './control-plane';
import type { RunCoordinator } from './run-coordinator';
import type { ExecutionSandbox } from './sandbox';
export interface Env {
  APP_ORIGIN: string;
  PROJECTS: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  MEGURI_GH_APP_ID: string;
  MEGURI_GH_APP_PRIVATE_KEY: string;
  MEGURI_GH_WEBHOOK_SECRET: string;
  ARTIFACTS: R2Bucket;
  CREDENTIALS: DurableObjectNamespace<CredentialBroker>;
  CONTROL: DurableObjectNamespace<ControlPlane>;
  RUNS: DurableObjectNamespace<RunCoordinator>;
  SANDBOXES: DurableObjectNamespace<ExecutionSandbox>;
}
