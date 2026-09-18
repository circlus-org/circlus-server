import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigRepository } from './config';

const S2S_SECRET = Buffer.alloc(32, 7).toString('base64');

function writeJson(directory: string, name: string, value: unknown): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  return filePath;
}

test('config without schemaVersion 1 is rejected', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-ice-unversioned-'));
  const configPath = writeJson(directory, 'config.json', {
    defaultTtlSeconds: 3600,
    stunUrls: ['stun:stun.example.test:3478'],
    turnClusters: [{
      id: 'main',
      status: 'active',
      urls: ['turn:turn.example.test:3478?transport=udp'],
      authMode: 'rest',
      staticAuthSecret: 'turn-secret'
    }],
    authorizedServers: [{
      serverId: 'server-1',
      keyId: 'k1',
      status: 'active',
      s2sSharedSecret: S2S_SECRET,
      defaultTurnClusterId: 'main'
    }]
  });

  assert.throws(() => ConfigRepository.load(configPath), /schemaVersion must be 1/);
});

test('versioned config resolves file secrets without logging their values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-ice-files-'));
  const turnSecret = 'file-turn-secret-that-must-not-be-logged';
  const s2sSecret = Buffer.alloc(32, 9).toString('base64');
  fs.writeFileSync(path.join(directory, 'turn.secret'), `${turnSecret}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 's2s.secret'), `${s2sSecret}\n`, 'utf8');
  const configPath = writeJson(directory, 'config.json', {
    schemaVersion: 1,
    defaultTtlSeconds: 1800,
    stunUrls: ['stun:stun.example.test:3478'],
    turnClusters: [{
      id: 'local',
      displayName: 'Local TURN',
      status: 'active',
      ownership: 'local',
      location: 'Current VPS',
      urls: ['turn:turn.example.test:3478?transport=udp'],
      auth: {
        mode: 'turn-rest-secret',
        secretFile: './turn.secret',
        ttlSeconds: 900
      }
    }],
    authorizedServers: [{
      serverId: 'server-1',
      keyId: 'k1',
      status: 'active',
      s2sSharedSecretFile: './s2s.secret',
      defaultTurnClusterId: 'local',
      allowedTurnClusterIds: ['local']
    }]
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  try {
    const repository = ConfigRepository.load(configPath);
    const cluster = repository.getTurnCluster('local');
    const server = repository.getAuthorizedServer('server-1', 'k1');
    assert.equal(cluster?.auth.mode, 'turn-rest-secret');
    assert.equal(cluster?.auth.mode === 'turn-rest-secret' ? cluster.auth.secret : null, turnSecret);
    assert.equal(server?.s2sSharedSecret, s2sSecret);
    assert.equal(cluster ? repository.getCredentialTtlSeconds(cluster) : null, 900);
    assert.deepEqual(repository.listAllowedTurnClusters(server!), [{
      id: 'local',
      displayName: 'Local TURN',
      status: 'active',
      ownership: 'local',
      location: 'Current VPS',
      urls: ['turn:turn.example.test:3478?transport=udp'],
      authMode: 'turn-rest-secret'
    }]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.join('\n').includes(turnSecret), false);
  assert.equal(logs.join('\n').includes(s2sSecret), false);
});

test('config rejects allowed clusters that are not defined', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-ice-invalid-'));
  const configPath = writeJson(directory, 'config.json', {
    schemaVersion: 1,
    turnClusters: [{
      id: 'local',
      urls: ['turn:turn.example.test:3478'],
      auth: {
        mode: 'turn-rest-secret',
        secret: 'turn-secret'
      }
    }],
    authorizedServers: [{
      serverId: 'server-1',
      keyId: 'k1',
      s2sSharedSecret: S2S_SECRET,
      defaultTurnClusterId: 'local',
      allowedTurnClusterIds: ['local', 'missing']
    }]
  });

  assert.throws(() => ConfigRepository.load(configPath), /unknown TURN cluster: missing/);
});
