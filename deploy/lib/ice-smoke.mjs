import crypto from 'node:crypto';
import fs from 'node:fs';

export function loadDeploymentEnv() {
  const file = process.env.CIRCLUS_ENV_FILE || 'deploy/.env';
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

// Exercise the same signed ICE API and credentials used by the application.
export async function requestTurnCredentials() {
  loadDeploymentEnv();
  const endpoint = process.env.ICE_SMOKE_URL
    || `http://127.0.0.1:${process.env.ICE_CONFIG_HOST_PORT || 3090}/v1/ice-servers`;
  const serverId = process.env.VPS_ID || 'home-vps-1';
  const keyId = process.env.ICE_CONFIG_KEY_ID || 'k1';
  const requestedCluster = process.env.ICE_SMOKE_TURN_CLUSTER_ID === undefined
    ? 'local' : process.env.ICE_SMOKE_TURN_CLUSTER_ID.trim();
  const expectedCluster = process.env.ICE_SMOKE_EXPECTED_TURN_CLUSTER_ID || requestedCluster || 'local';
  const secretFile = process.env.ICE_S2S_SECRET_FILE || 'deploy/secrets/ice-s2s.secret';
  let secret;
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    throw new Error(`cannot read S2S secret file: ${secretFile}`);
  }
  if (!secret) throw new Error('S2S secret file is empty');
  const body = JSON.stringify({
    vpsId: serverId,
    familyId: 'ice-smoke-test',
    purpose: 'call',
    circleSubjectId: 'cs1_AAAAAAAAAAAAAAAAAAAAAA',
    mediaSessionId: 'ms1_AAAAAAAAAAAAAAAAAAAAAA',
    ...(requestedCluster ? { requestedTurnClusterId: requestedCluster } : {})
  });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(body).digest('base64url');
  const canonical = ['POST', new URL(endpoint).pathname, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(canonical).digest('base64url');
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
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
  if (!response.ok) throw new Error(`ICE service returned HTTP ${response.status}`);
  const result = (await response.json())?.result;
  if (result?.assignment?.turnClusterId !== expectedCluster) {
    throw new Error('unexpected TURN cluster assignment');
  }
  const turn = result?.iceServers?.find(entry => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
  });
  if (!turn?.username || !turn?.credential || !turn?.expiresAt) {
    throw new Error('ICE response does not contain short-lived TURN credentials');
  }
  if (turn.credential === secret) throw new Error('ICE response exposed a shared secret');
  return { ...turn, turnClusterId: expectedCluster };
}
