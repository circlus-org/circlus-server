import express from 'express';
import type { IncomingMessage } from 'node:http';
import { wsClientAddress } from './wsClientAddress';

test('WS IP limits use the same trust-proxy policy as HTTP', () => {
  const app = express();
  const request = { socket: { remoteAddress: '127.0.0.1' }, connection: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.2' } } as unknown as IncomingMessage;
  expect(wsClientAddress(app, request)).toBe('127.0.0.1');
  app.set('trust proxy', 1);
  expect(wsClientAddress(app, request)).toBe('198.51.100.2');
  app.set('trust proxy', ['10.0.0.0/8']);
  expect(wsClientAddress(app, request)).toBe('127.0.0.1');
});
