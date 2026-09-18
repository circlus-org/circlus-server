// Actual loopback WebSockets; no application database, credentials or external services.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const WebSocket = require('ws');
const { WsResourceGuard, markWebSocketRegistered } = require('../dist/server/src/ws/wsResourceGuard');
const { loadCallRuntimeConfig } = require('../dist/server/src/config/callRuntimeConfig');

const clients = new Set();
const transports = new Set();
const errors = [];
let releaseBlocked;
const blocked = new Promise(resolve => { releaseBlocked = resolve; });
const handled = [];
const server = createServer();
const admissions = new WeakMap();
const settings = { ...loadCallRuntimeConfig({}).webSocket.limits,
  registrationTimeoutMs: 250, maxQueuedMessages: 4, maxOutgoingMessages: 8 };
const guard = new WsResourceGuard(settings, async (ws, data) => {
  const value = JSON.parse(data.toString());
  if (value.type === 'register') {
    // Authentication itself belongs to the existing registration-handler tests.
    markWebSocketRegistered(ws);
    ws.send(JSON.stringify({ registered: true }));
  } else if (value.type === 'block') {
    handled.push('block'); await blocked;
  } else if (value.type === 'send-burst') {
    for (let i = 0; i < 20; i++) ws.send('outgoing');
  } else {
    handled.push(value.type);
    ws.send(JSON.stringify(value));
  }
}, error => errors.push(error), () => {});
const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024, verifyClient(info, done) {
  const lease = guard.reserve(info.req.socket.remoteAddress, info.req.socket);
  if (!lease) return done(false, 503, 'limit');
  admissions.set(info.req, lease); done(true);
} });
wss.on('connection', (ws, req) => {
  transports.add(ws); ws.once('close', () => transports.delete(ws));
  if (!guard.attach(ws, admissions.get(req))) return;
  ws.on('message', data => guard.enqueue(ws, data));
  ws.on('error', error => errors.push(error));
});

async function connect(register = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  clients.add(ws); ws.once('close', () => clients.delete(ws));
  await once(ws, 'open');
  if (register) {
    const reply = once(ws, 'message'); ws.send(JSON.stringify({ type: 'register' }));
    assert.equal(JSON.parse((await reply)[0]).registered, true);
  }
  return ws;
}

async function main() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const idle = await connect(false);
    assert.equal((await once(idle, 'close'))[0], 1008, 'Unregistered connection must expire');
    const overloaded = await connect();
    const closed = once(overloaded, 'close');
    overloaded.send(JSON.stringify({ type: 'block' }));
    for (let i = 0; i < 10; i++) overloaded.send(JSON.stringify({ type: 'must-not-run' }));
    assert.equal((await closed)[0], 1013);
    assert.deepEqual(handled, ['block']);
    releaseBlocked(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(guard.snapshot().queuedMessages, 0);

    // A replacement connection can register and preserve signaling order after overload.
    const replacement = await connect();
    const received = [];
    const messages = new Promise(resolve => replacement.on('message', data => {
      received.push(JSON.parse(data.toString()).type); if (received.length === 3) resolve();
    }));
    for (const type of ['offer', 'answer', 'ice']) replacement.send(JSON.stringify({ type }));
    await messages;
    assert.deepEqual(received, ['offer', 'answer', 'ice']);
    const pong = once(replacement, 'pong'); replacement.ping('probe');
    assert.equal((await pong)[0].toString(), 'probe');
    const normalClose = once(replacement, 'close'); replacement.close(); await normalClose;

    const slow = await connect();
    // Do not parse data frames here; this connection intentionally receives a burst.
    const slowClosed = once(slow, 'close'); slow.send(JSON.stringify({ type: 'send-burst' }));
    assert.equal((await slowClosed)[0], 1013);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(guard.snapshot(), { connections: 0, unregisteredConnections: 0,
      queuedMessages: 0, queuedBytes: 0, outgoingBytes: 0, outgoingMessages: 0 });
    assert.deepEqual(errors, []);
    console.log('PASS: actual WS registration deadline, inbound overflow, reconnect/order, automatic pong, outgoing burst limit and released budgets.');
  } finally {
    releaseBlocked();
    for (const ws of clients) ws.terminate();
    for (const ws of transports) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}
const deadline = setTimeout(() => { console.error('WS integration test timed out'); process.exit(1); }, 15000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
