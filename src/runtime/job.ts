import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../core/ports';
import type { AgentResult, FileChange, RunnerJob } from '../contracts/index';

export function command(argv: string[], cwd: string, signal: AbortSignal, emit?: (type: string, data: unknown) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const chunks: Buffer[] = []; let size = 0;
    const abort = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (buffer: Buffer) => {
      size += buffer.length;
      if (size > 12_000_000) { abort(); return; }
      chunks.push(buffer); emit?.('command.stdout', buffer.toString());
    });
    child.stderr.on('data', (buffer: Buffer) => emit?.('command.stderr', buffer.toString()));
    child.on('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('Command cancelled'));
      else if (size > 12_000_000) reject(new Error('Command output exceeds prototype limit'));
      else if (code !== 0) reject(new Error(`Command ${argv[0]} exited (${code})`));
      else resolve(Buffer.concat(chunks));
    });
  });
}
const git = (args: string[], cwd: string, signal: AbortSignal) => command(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd, signal);

export async function collectChanges(cwd: string, baseSha: string, signal: AbortSignal): Promise<FileChange[]> {
  await git(['add', '--all'], cwd, signal);
  const names = (await git(['diff', '--cached', '--no-renames', '--name-only', '-z', baseSha, '--'], cwd, signal)).toString().split('\0').filter(Boolean);
  if (names.length > 100) throw new Error('More than 100 changed files; refusing partial publication');
  const entries = (await git(['ls-files', '--stage', '-z'], cwd, signal)).toString().split('\0').filter(Boolean);
  const index = new Map(entries.map(entry => {
    const tab = entry.indexOf('\t'); const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    if (stage !== '0') throw new Error('Unmerged files in workspace');
    return [entry.slice(tab + 1), { mode, sha }];
  }));
  let total = 0;
  const changes: FileChange[] = [];
  for (const path of names) {
    const entry = index.get(path);
    if (!entry) { changes.push({ path, mode: '100644', contentBase64: null }); continue; }
    if (!['100644', '100755', '120000'].includes(entry.mode!)) throw new Error('Submodule changes are not supported in the prototype');
    const content = await git(['cat-file', 'blob', entry.sha!], cwd, signal);
    total += content.length;
    if (content.length > 1_000_000 || total > 7_000_000) throw new Error('Changes exceed prototype size limit');
    changes.push({ path, mode: entry.mode as FileChange['mode'], contentBase64: content.toString('base64') });
  }
  return changes;
}

export async function executeJob(job: RunnerJob, adapter: AgentAdapter, context: Parameters<AgentAdapter['run']>[1]): Promise<AgentResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(job.repository) || !/^[a-f0-9]{40,64}$/.test(job.issue.baseSha)) throw new Error('Invalid repository revision');
  const root = await mkdtemp(join(tmpdir(), 'meguri-job-'));
  const cwd = join(root, 'repo');
  try {
    context.emit('workspace.clone', { repository: job.repository, baseSha: job.issue.baseSha });
    await command(['git', 'clone', '--no-checkout', '--', `https://github.com/${job.repository}.git`, cwd], root, context.signal, context.emit);
    await git(['checkout', '--detach', job.issue.baseSha], cwd, context.signal);
    for (const script of job.setupCommands) {
      context.emit('workspace.setup', { command: script });
      await command(['bash', '-lc', script], cwd, context.signal, context.emit);
    }
    const result = await adapter.run(job, { ...context, cwd });
    for (const script of job.testCommands) {
      context.emit('workspace.test', { command: script });
      await command(['bash', '-lc', script], cwd, context.signal, context.emit);
    }
    return { ...result, changes: await collectChanges(cwd, job.issue.baseSha, context.signal) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
