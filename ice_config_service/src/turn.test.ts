import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { generateTurnServer } from './turn';

test('TURN credentials contain opaque circle and media session subjects', () => {
  const staticAuthSecret = 'turn-secret';
  const turn = generateTurnServer({
    cluster: {
      id: 'local',
      displayName: 'Local TURN',
      ownership: 'local',
      urls: ['turn:turn.example.test:3478'],
      auth: { mode: 'turn-rest-secret', secret: staticAuthSecret }
    },
    server: {
      serverId: 'server-1',
      keyId: 'k1',
      s2sSharedSecret: 'unused',
      defaultTurnClusterId: 'local',
      allowedTurnClusterIds: ['local']
    },
    vpsId: 'vps-1',
    circleSubjectId: 'cs1_abcdefghijklmnopqrstuv',
    mediaSessionId: 'ms1_abcdefghijklmnopqrstuv',
    ttlSeconds: 3600
  });

  assert.match(
    turn.username || '',
    /^\d+:v1:server-1:vps-1:cs1_abcdefghijklmnopqrstuv:ms1_abcdefghijklmnopqrstuv:local:k1$/
  );
  assert.equal(
    turn.credential,
    crypto.createHmac('sha1', staticAuthSecret).update(turn.username || '').digest('base64')
  );
  assert.doesNotMatch(turn.username || '', /family|call_temp/);
});

test('static TURN credentials are returned without inventing an expiry', () => {
  const turn = generateTurnServer({
    cluster: {
      id: 'external',
      displayName: 'External TURN',
      ownership: 'external',
      urls: ['turns:turn.example.test:5349?transport=tcp'],
      auth: { mode: 'static-credentials', username: 'test-user', credential: 'test-password' }
    },
    server: {
      serverId: 'server-1',
      keyId: 'k1',
      s2sSharedSecret: 'unused',
      defaultTurnClusterId: 'external',
      allowedTurnClusterIds: ['external']
    },
    vpsId: 'vps-1',
    circleSubjectId: 'cs1_abcdefghijklmnopqrstuv'
  });

  assert.equal(turn.username, 'test-user');
  assert.equal(turn.credential, 'test-password');
  assert.equal(turn.expiresAt, undefined);
});
