import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CodexRpc } from '../src/adapters/agents/codex';
it('initializes the pinned Codex app-server without reading an existing login or calling a model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'meguri-protocol-test-'));
  const child = spawn(resolve('node_modules/.bin/codex'), ['app-server', '--listen', 'stdio://', '-c', 'features.plugins=false'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
  });
  const rpc = new CodexRpc(child);
  child.stderr.resume();
  try {
    const initialized = await rpc.call('initialize', { clientInfo: { name: 'meguri-test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    expect(initialized).toHaveProperty('userAgent');
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.call('account/read', { refreshToken: false }); expect(account.account).toBeNull();
  } finally { rpc.close(); await rm(home, { recursive: true, force: true }); }
});
