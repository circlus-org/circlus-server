#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

const endpoint = process.env.ICE_SMOKE_URL || 'http://127.0.0.1:3090/v1/ice-servers';
const serverId = process.env.VPS_ID || 'home-vps-1';
const keyId = process.env.ICE_CONFIG_KEY_ID || 'k1';
const requestedTurnClusterId = process.env.ICE_SMOKE_TURN_CLUSTER_ID === undefined
  ? 'local'
  : process.env.ICE_SMOKE_TURN_CLUSTER_ID.trim();
const expectedTurnClusterId = process.env.ICE_SMOKE_EXPECTED_TURN_CLUSTER_ID
  || requestedTurnClusterId
  || 'local';
const secretFile = process.env.ICE_S2S_SECRET_FILE || './deploy/secrets/ice-s2s.secret';

function fail(message) {
  console.error(`ICE smoke test failed: ${message}`);
  process.exit(1);
}

let secretBase64;
try {
  secretBase64 = fs.readFileSync(secretFile, 'utf8').trim();
} catch {
  fail(`cannot read S2S secret file: ${secretFile}`);
}
if (!secretBase64) fail(`S2S secret file is empty: ${secretFile}`);

const requestPath = new URL(endpoint).pathname;
const body = JSON.stringify({
  vpsId: serverId,
  familyId: 'ice-smoke-test',
  purpose: 'call',
  circleSubjectId: 'cs1_AAAAAAAAAAAAAAAAAAAAAA',
  mediaSessionId: 'ms1_AAAAAAAAAAAAAAAAAAAAAA',
  ...(requestedTurnClusterId ? { requestedTurnClusterId } : {})
});
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(12).toString('base64url');
const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('base64url');
const canonical = ['POST', requestPath, timestamp, nonce, bodyHash].join('\n');
const signature = crypto
  .createHmac('sha256', Buffer.from(secretBase64, 'base64'))
  .update(canonical, 'utf8')
  .digest('base64url');

let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Ice-Server-Id': serverId,
      'X-Ice-Key-Id': keyId,
      'X-Ice-Timestamp': timestamp,
      'X-Ice-Nonce': nonce,
      'X-Ice-Body-Sha256': bodyHash,
      'X-Ice-Signature': signature
    },
    body
  });
} catch (error) {
  fail(`cannot reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
}
const responseBody = await response.json().catch(() => null);
if (!response.ok) {
  fail(`service returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
}

const result = responseBody?.result;
if (result?.assignment?.turnClusterId !== expectedTurnClusterId) {
  fail(`unexpected TURN cluster assignment: ${JSON.stringify(result?.assignment)}`);
}
const turnServer = result?.iceServers?.find((entry) => {
  const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
  return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
});
if (!turnServer?.username || !turnServer?.credential || !turnServer?.expiresAt) {
  fail('response does not contain short-lived TURN REST credentials');
}
if (turnServer.credential === secretBase64) {
  fail('response exposed the configured TURN secret');
}

console.log(`ICE smoke test passed for TURN cluster: ${expectedTurnClusterId}`);
