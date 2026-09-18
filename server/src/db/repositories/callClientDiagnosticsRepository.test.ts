const mockQuery = jest.fn();
jest.mock('../index', () => ({ pool: { query: (...args: unknown[]) => mockQuery(...args) } }));

import { CallClientDiagnosticsRepository } from './callClientDiagnosticsRepository';
import type { CallMediaQualitySummary } from '@shared/types';

it('stores optional audio diagnostics intact in the existing media-quality JSON', async () => {
  const mediaQuality: CallMediaQualitySummary = {
    schemaVersion: 1, sampleCount: 2, startedAtMs: 1000, endedAtMs: 3000,
    usedRelay: false, reconnectCount: 0,
    audio: {
      intervalHistory: {
        columns: ['atMs', 'durationMs', 'sent', 'received', 'playoutMs', 'flags'],
        rows: [[2000, 1000, 50, 0, null, 2]], observedIntervals: 1, omittedIntervals: 0
      },
      packetsLost: 0, packetsDiscarded: 2, concealedSamples: 480,
      silentConcealedSamples: 0, concealmentEvents: 1,
      concealmentPercent: { average: 1, maximum: 10 },
      jitterBufferDelayMs: { average: 40, maximum: 120 },
      jitterBufferTargetDelayMs: { average: 50, maximum: 150 },
      removedSamplesForAcceleration: 240
    }
  };
  await new CallClientDiagnosticsRepository().save({
    familyId: 'family-1', callSessionId: 'call-1', identityId: 'alice', deviceId: 'device-1',
    report: { everConnected: true, reachedReconnecting: false, mediaQuality }
  });
  const values = mockQuery.mock.calls[0][1];
  expect(JSON.parse(values[14])).toEqual(mediaQuality);
  expect(JSON.parse(values[14]).audio).not.toHaveProperty('jitterBufferMinimumDelayMs');
});
