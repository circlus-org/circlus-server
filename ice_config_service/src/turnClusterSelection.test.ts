import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigRepository } from './config';
import { selectTurnCluster, TurnClusterSelectionError } from './turnClusterSelection';

function createRepository(): ConfigRepository {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'circlus-ice-selection-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    turnClusters: [
      { id: 'local', urls: ['turn:local.example.test:3478'], auth: { mode: 'turn-rest-secret', secret: 'local-secret' } },
      { id: 'external', urls: ['turn:external.example.test:3478'], auth: { mode: 'turn-rest-secret', secret: 'external-secret' } },
      { id: 'disabled', status: 'disabled', urls: ['turn:disabled.example.test:3478'], auth: { mode: 'turn-rest-secret', secret: 'disabled-secret' } }
    ],
    authorizedServers: [{
      serverId: 'server-1',
      keyId: 'k1',
      s2sSharedSecret: Buffer.alloc(32, 3).toString('base64'),
      defaultTurnClusterId: 'local',
      allowedTurnClusterIds: ['local', 'external', 'disabled']
    }]
  }), 'utf8');
  return ConfigRepository.load(configPath);
}

test('missing requested cluster preserves the existing default selection', () => {
  const repository = createRepository();
  const server = repository.getAuthorizedServer('server-1', 'k1');
  assert.ok(server);
  const selected = selectTurnCluster({ repository, server });
  assert.equal(selected.cluster.id, 'local');
  assert.equal(selected.selectionSource, 'default');
});

test('an explicitly requested allowed cluster is selected', () => {
  const repository = createRepository();
  const server = repository.getAuthorizedServer('server-1', 'k1');
  assert.ok(server);
  const selected = selectTurnCluster({ repository, server, requestedTurnClusterId: 'external' });
  assert.equal(selected.cluster.id, 'external');
  assert.equal(selected.selectionSource, 'requested');
});

test('unknown, forbidden and disabled clusters have distinct safe errors', () => {
  const repository = createRepository();
  const server = repository.getAuthorizedServer('server-1', 'k1');
  assert.ok(server);

  assert.throws(
    () => selectTurnCluster({ repository, server, requestedTurnClusterId: 'missing' }),
    (error) => error instanceof TurnClusterSelectionError && error.statusCode === 400
  );
  assert.throws(
    () => selectTurnCluster({
      repository,
      server: { ...server, allowedTurnClusterIds: ['local'] },
      requestedTurnClusterId: 'external'
    }),
    (error) => error instanceof TurnClusterSelectionError && error.statusCode === 403
  );
  assert.throws(
    () => selectTurnCluster({ repository, server, requestedTurnClusterId: 'disabled' }),
    (error) => error instanceof TurnClusterSelectionError && error.statusCode === 503
  );
});
