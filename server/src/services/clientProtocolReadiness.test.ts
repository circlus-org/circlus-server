jest.mock('../db', () => ({ query: jest.fn() }));

import { SIGNED_PROTOCOL_RANGES, SIGNED_PROTOCOL_VERSIONS, parseClientProtocolsReport } from '../../../shared/protocolVersions';
import { groupClientProtocolReadiness } from './clientProtocolReadiness';

const envelope = SIGNED_PROTOCOL_VERSIONS.signedRequestEnvelope;
// A support window: the server accepts the previous and a new envelope version.
const windowRanges = {
  ...SIGNED_PROTOCOL_RANGES,
  signedRequestEnvelope: { min: envelope, max: envelope + 1, minRaisesAt: '2027-03-01' }
};
const seen = (day: number) => new Date(Date.UTC(2027, 0, day));

test('lists devices whose app is not ready for the newest accepted version, with the end date', () => {
  const rows = groupClientProtocolReadiness([
    { client_version: 'ios 1.0 (12)', client_protocols: { ...SIGNED_PROTOCOL_VERSIONS }, last_seen_at: seen(2) },
    { client_version: 'ios 1.0 (12)', client_protocols: { ...SIGNED_PROTOCOL_VERSIONS }, last_seen_at: seen(5) },
    { client_version: 'ios 1.1 (13)', client_protocols: { ...SIGNED_PROTOCOL_VERSIONS, signedRequestEnvelope: envelope + 1 }, last_seen_at: seen(6) },
    { client_version: null, client_protocols: null, last_seen_at: seen(1) },
  ], windowRanges);
  expect(rows).toEqual([
    { client_version: 'ios 1.0 (12)', not_ready_for: `signedRequestEnvelope ${envelope + 1}`,
      support_ends: '2027-03-01', devices: 2, last_seen_at: seen(5) },
    { client_version: 'unknown', not_ready_for: 'not reported', support_ends: '', devices: 1, last_seen_at: seen(1) },
  ]);
});

test('current apps are not listed outside a support window', () => {
  expect(groupClientProtocolReadiness([
    { client_version: 'web 1', client_protocols: { ...SIGNED_PROTOCOL_VERSIONS }, last_seen_at: seen(1) },
  ])).toEqual([]);
});

test('protocol reports are parsed strictly and skip unknown names', () => {
  expect(parseClientProtocolsReport(`signedRequestEnvelope=${envelope},futureProtocol=1`))
    .toEqual({ signedRequestEnvelope: envelope });
  expect(parseClientProtocolsReport('signedRequestEnvelope=0')).toBeNull();
  expect(parseClientProtocolsReport('signedRequestEnvelope=3;drop')).toBeNull();
  expect(parseClientProtocolsReport('futureProtocol=1')).toBeNull();
  expect(parseClientProtocolsReport('x'.repeat(513))).toBeNull();
  expect(parseClientProtocolsReport(undefined)).toBeNull();
});
