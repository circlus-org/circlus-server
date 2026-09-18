// Real HTTP lost-response regression for the transport; authentication is covered by handler tests.
const assert = require('node:assert/strict');
const http = require('node:http');
const { HttpCallRuntimeSessionManager } = require('../dist/server/src/ws/httpCallRuntimeSessionManager');
let registered = new WeakSet();
let processed = [];
const manager = new HttpCallRuntimeSessionManager({
  sessionTtlMs: 60_000, maxPollMs: 50, setSocketFamilyContext() {},
  hasConnectionInfo: ws => registered.has(ws), handleClose: ws => registered.delete(ws),
  async handleMessage(ws, message) {
    if (message.type === 'register') {
      registered.add(ws);
      manager.findQueueBySocket(ws).enqueue({type: 'registered', data: {}, timestamp: 0});
    } else {
      processed.push(message.type);
      manager.findQueueBySocket(ws).enqueue(message);
    }
  }
});
let loseSend = true, losePoll = true;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const scope = {sessionId: req.headers.authorization?.slice(7), familyId: 'circle'};
    let result;
    if (req.url === '/register') result = await manager.create({familyId: 'circle', protocol: 2, registration: body});
    if (req.url === '/send') {
      result = await manager.send({...scope, ...body});
      if (loseSend) { loseSend = false; req.socket.destroy(); return; }
    }
    if (req.url === '/poll') {
      result = await manager.poll({...scope, ...body, timeoutMs: 0});
      if (losePoll) { losePoll = false; req.socket.destroy(); return; }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({error: error.message})); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, sessionId) => {
    const response = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(sessionId ? {Authorization: `Bearer ${sessionId}`} : {})}, body: JSON.stringify(body)});
    return response.json();
  };
  let id;
  try {
    const session = await post('/register', {type: 'register', data: {}, timestamp: 0});
    assert.equal(session.ok, true); id = session.sessionId;
    const message = {type: 'call:offer', data: {callSessionId: 'one'}, timestamp: 0};
    await assert.rejects(post('/send', {sequence: 1, message}, id));
    assert.equal((await post('/send', {sequence: 1, message}, id)).ok, true);
    await assert.rejects(post('/poll', {ack: 0}, id));
    const events = (await post('/poll', {ack: 0}, id)).events;
    assert.deepEqual(events.map(event => event.message.type), ['registered', 'call:offer']);
    assert.deepEqual((await post('/poll', {ack: 0}, id)).events, events);
    assert.deepEqual((await post('/poll', {ack: 2}, id)).events, []);
    assert.deepEqual(processed, ['call:offer']);
    console.log('HTTP signaling: lost send/poll responses, deduplication and ACK passed');
  } finally {
    if (id) manager.close(id);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
