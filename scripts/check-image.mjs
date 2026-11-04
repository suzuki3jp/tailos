import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const image = process.argv[2] || 'meguri-runner:test';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = docker(['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'codex', image, '--version']);
if (!version.includes('0.166.0')) throw new Error(`Unexpected Codex version: ${version}`);
const name = `meguri-image-check-${randomUUID()}`;
docker(['run', '--rm', '--detach', '--platform', 'linux/amd64', '--name', name, image]);
try {
  let ready = false;
  const probe = `const r=await fetch('http://127.0.0.1:8080/health');if(r.status!==200)process.exit(1);const bad=await fetch('http://127.0.0.1:8080/job',{method:'POST',body:JSON.stringify({runId:'smoke',engine:'unknown',deadline:Date.now()+60000})});if(bad.status!==400)process.exit(1);`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { docker(['exec', name, 'node', '--input-type=module', '-e', probe]); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('Runner image did not pass its health check');
  console.log(`Runner image passed: ${version}, HTTP health, invalid-job rejection.`);
} finally { docker(['stop', '--time', '1', name]); }
