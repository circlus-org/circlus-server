#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadDeploymentEnv, requestTurnCredentials } from './lib/ice-smoke.mjs';

// No shared secret leaves the server. Exported credentials expire at expiresAt.
async function main() {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (extra.length || (mode && (!['--write-credentials', '--credentials'].includes(mode) || !file))) {
    throw new Error('usage: node deploy/smoke-test-turn.mjs [--write-credentials FILE | --credentials FILE]');
  }
  loadDeploymentEnv();
  const turn = mode === '--credentials'
    ? JSON.parse(fs.readFileSync(file, 'utf8')) : await requestTurnCredentials();
  if (!turn.username || !turn.credential || !(Date.parse(turn.expiresAt) > Date.now())) {
    throw new Error('TURN credentials are missing or expired; request a new file on the server');
  }
  if (mode === '--write-credentials') {
    fs.writeFileSync(file, JSON.stringify(turn), { mode: 0o600, flag: 'wx' });
    console.log(`Temporary credentials written to ${file}; expire at ${turn.expiresAt}.`);
    return;
  }
  const urls = Array.isArray(turn.urls) ? turn.urls : [turn.urls];
  if (!urls.length) throw new Error('no TURN URLs to test');
  for (const url of urls) {
    const parsed = /^(turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/.exec(url);
    if (!parsed) throw new Error('unsupported TURN URL');
    const [, scheme, rawHost, rawPort, transport] = parsed;
    const host = rawHost.replace(/^\[|\]$/g, '');
    const port = rawPort || (scheme === 'turns' ? '5349' : '3478');
    const tcp = transport === 'tcp' || (scheme === 'turns' && !transport);
    const args = ['-y', '-c', '-n', '20', '-m', '2', '-u', turn.username, '-w', turn.credential,
      '-p', port, ...(tcp ? ['-t'] : []), ...(scheme === 'turns' ? ['-S'] : []), host];
    const localClient = process.env.TURN_SMOKE_CLIENT;
    const command = localClient || 'docker';
    const commandArgs = localClient ? args : ['compose', '--env-file',
      process.env.CIRCLUS_ENV_FILE || 'deploy/.env', '--profile', 'local-turn',
      'exec', '-T', 'coturn', 'timeout', '25', 'turnutils_uclient', ...args];
    console.log(`Testing ${url} (${localClient ? 'this machine' : 'coturn container'})...`);
    const result = spawnSync(command, commandArgs, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    // uclient can exit successfully despite packet loss. Require a completed
    // exchange, not just successful allocation or an exit code of zero.
    const counters = [...output.matchAll(/tot_send_msgs=(\d+),\s*tot_recv_msgs=(\d+)/g)].at(-1);
    if (result.error || result.status !== 0 || !counters || Number(counters[1]) === 0
        || Number(counters[1]) !== Number(counters[2])) {
      const safeOutput = output.replaceAll(turn.credential, '[redacted]').replaceAll(turn.username, '[user]');
      if (safeOutput.trim()) console.error(safeOutput.slice(-6000));
      throw new Error(`TURN relay test failed for ${url}${result.error ? `: ${result.error.code}` : ''}`);
    }
    console.log(`PASS: ${counters[2]}/${counters[1]} messages received.`);
  }
  console.log('TURN authentication and relay exchange passed from this test location.');
  console.log('Also test from an external network and make an Always TURN call; local success does not verify public firewall rules.');
}
main().catch(error => {
  console.error(`TURN smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
