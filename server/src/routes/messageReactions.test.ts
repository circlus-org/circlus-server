import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import { createSignatureMessage } from '../../../shared/signatureMessage';
import type { ReactionClaim } from '../../../shared/messageReactions';
import { initializeDatabase, closeDatabase, query } from '../db';
import { messageReactionsHandler } from './messageReactions';
import { groupChatRepository, identityRepository, messageRepository } from '../db/repositories';
import { resolveDirectCommunicationAccess } from '../services/directGuestAccessService';
import { hasPendingGroupLeaveRequest } from './groupChatsAccess';
import { sendDirectChatWsEvent } from '../ws/wsGateway';
import type { AuthRequest } from '../middleware/auth';
import type { Response } from 'express';

jest.mock('../db/repositories', () => ({
  groupChatRepository: { findParticipant: jest.fn(), findChat: jest.fn(), findMessageById: jest.fn(), listActiveParticipants: jest.fn() },
  identityRepository: { findByIdentityId: jest.fn() }, messageRepository: { findMessageById: jest.fn() }
}));
jest.mock('../services/directGuestAccessService', () => ({ resolveDirectCommunicationAccess: jest.fn() }));
jest.mock('./groupChatsAccess', () => ({ hasPendingGroupLeaveRequest: jest.fn() }));
jest.mock('../ws/wsGateway', () => ({ sendDirectChatWsEvent: jest.fn(), sendGroupChatWsEvent: jest.fn() }));

// Run against an isolated PostgreSQL database; the test owns only its random schema.
const describeDatabase = process.env.REACTION_TEST_DATABASE_URL ? describe : describe.skip;
describeDatabase('encrypted reaction API with real PostgreSQL compare-and-set', () => {
  const schema = `reaction_test_${process.pid}`;
  const family = '00000000-0000-0000-0000-000000000001';
  const pair = nacl.sign.keyPair();
  const publicKey = Buffer.from(pair.publicKey).toString('base64');
  function claim(revision = 1, overrides = {}): ReactionClaim {
    const unsigned = { type: 'message:reaction-author', signerId: 'alice', timestamp: 123, nonce: 'nonce',
      payload: { version: 1 as const, scope: 'direct' as const, chatId: 'alice::bob', messageId: 'm', actorIdentityId: 'alice', revision, epoch: 1,
        ciphertext: `dcm1:${Buffer.alloc(60, revision).toString('base64')}`, ...overrides } };
    return { ...unsigned, signature: Buffer.from(nacl.sign.detached(Buffer.from(createSignatureMessage(unsigned)), pair.secretKey)).toString('base64') };
  }
  async function call(write: boolean, payload: object, scope: 'direct' | 'group' = 'direct') {
    let status = 200;
    let body: any;
    const res = { status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; } };
    let failure: unknown;
    await messageReactionsHandler(scope, write)({ familyId: family, device: { identityId: 'alice' }, params: { chatId: 'group' },
      signedRequest: { payload: { peerIdentityId: 'bob', ...payload } } } as unknown as AuthRequest, res as unknown as Response,
    (error?: unknown) => { failure = error; });
    if (failure) throw failure;
    return { status, body };
  }
  beforeAll(async () => {
    const url = new URL(process.env.REACTION_TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    initializeDatabase(url.toString());
    await query(`CREATE SCHEMA ${schema}`);
    await query(`CREATE TABLE messages (server_message_id text PRIMARY KEY, deleted_at bigint, family_id uuid, sender_identity_id text, recipient_identity_id text);
      CREATE TABLE group_chat_messages (message_id text PRIMARY KEY, deleted_at bigint, family_id uuid, chat_id text, kind text);
      CREATE TABLE identities (family_id uuid, identity_id text, public_key_algorithm text, public_key_value text);
      CREATE TABLE direct_chat_epoch_state (family_id uuid, direct_chat_id text, current_epoch integer);`);
    await query(fs.readFileSync(path.resolve(__dirname, '../../db/migrations/000-pre-public/155_message_reactions.sql'), 'utf8'));
    await query('INSERT INTO identities VALUES ($1,$2,$3,$4)', [family, 'alice', 'ed25519', publicKey]);
    await query('INSERT INTO direct_chat_epoch_state VALUES ($1,$2,1)', [family, 'alice::bob']);
  });
  afterAll(async () => { await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await closeDatabase(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    await query("TRUNCATE message_reaction_states, messages, group_chat_messages");
    await query("INSERT INTO messages VALUES ('m',NULL,$1,'alice','bob')", [family]);
    await query("INSERT INTO group_chat_messages VALUES ('m',NULL,$1,'group','user')", [family]);
    (identityRepository.findByIdentityId as jest.Mock).mockResolvedValue({ public_key_algorithm: 'ed25519', public_key_value: publicKey });
    (messageRepository.findMessageById as jest.Mock).mockResolvedValue({ sender_identity_id: 'alice', recipient_identity_id: 'bob', deleted_at: null });
    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({ allowed: true });
    (groupChatRepository.findParticipant as jest.Mock).mockResolvedValue({ is_active: true });
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 1, protocol_version: 2, rekey_required_at: null });
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({ kind: 'user', deleted_at: null });
    (groupChatRepository.listActiveParticipants as jest.Mock).mockResolvedValue([{ identity_id: 'alice' }, { identity_id: 'bob' }]);
    (hasPendingGroupLeaveRequest as jest.Mock).mockResolvedValue(false);
  });
  it('persists, lists and idempotently retries the same signed set', async () => {
    const first = claim();
    expect((await call(true, { claim: first })).status).toBe(200);
    expect((await call(true, { claim: first })).status).toBe(200);
    const listed = await call(false, { messageIds: ['m'] });
    expect(listed.body.result.records).toHaveLength(1);
    expect(listed.body.result.records[0].claim).toEqual(first);
    expect(sendDirectChatWsEvent).toHaveBeenCalledWith(family, 'bob', 'alice::bob', expect.objectContaining({ type: 'message:reactions-updated' }));
  });
  it('accepts exactly one of two concurrent different writes at the same revision', async () => {
    const a = claim(); const b = claim(1, { ciphertext: `dcm1:${Buffer.alloc(60, 9).toString('base64')}` });
    const results = await Promise.all([call(true, { claim: a }), call(true, { claim: b })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it('rejects stale retries after a later revision and accepts the next revision', async () => {
    expect((await call(true, { claim: claim() })).status).toBe(200);
    expect((await call(true, { claim: claim(2) })).status).toBe(200);
    expect((await call(true, { claim: claim() })).status).toBe(409);
    expect((await call(true, { claim: claim(4) })).status).toBe(409);
  });
  it('rejects wrong actor, chat, epoch, signature, nonmember access and foreign messages', async () => {
    expect((await call(true, { claim: claim(1, { actorIdentityId: 'bob' }) })).status).toBe(400);
    expect((await call(true, { claim: claim(1, { chatId: 'alice::other' }) })).status).toBe(400);
    expect((await call(true, { claim: claim(1, { epoch: 2 }) })).status).toBe(409);
    expect((await call(true, { claim: { ...claim(), signature: Buffer.alloc(64).toString('base64') } })).status).toBe(403);
    (messageRepository.findMessageById as jest.Mock).mockResolvedValue({ sender_identity_id: 'other', recipient_identity_id: 'bob', deleted_at: null });
    expect((await call(true, { claim: claim() })).status).toBe(403);
    (resolveDirectCommunicationAccess as jest.Mock).mockResolvedValue({ allowed: false });
    expect((await call(false, { messageIds: ['m'] })).status).toBe(403);
  });
  it('rejects deleted targets, hides their reactions, and cascades physical deletion', async () => {
    await call(true, { claim: claim() });
    await query("UPDATE messages SET deleted_at=1 WHERE server_message_id='m'");
    const unavailable = await call(false, { messageIds: ['m'] });
    expect(unavailable.body.result.records).toEqual([]);
    expect(unavailable.body.result.unavailableMessageIds).toEqual(['m']);
    (messageRepository.findMessageById as jest.Mock).mockResolvedValue({ deleted_at: 1 });
    expect((await call(true, { claim: claim(2) })).status).toBe(404);
    await query("DELETE FROM messages WHERE server_message_id='m'");
    expect((await query('SELECT * FROM message_reaction_states')).rowCount).toBe(0);
  });
  it('supports groups and blocks leaving participants, rekey and system messages', async () => {
    const groupClaim = claim(1, { scope: 'group', chatId: 'group', ciphertext: `gcm1:${Buffer.alloc(60).toString('base64')}` });
    expect((await call(true, { claim: groupClaim }, 'group')).status).toBe(200);
    expect((await call(false, { messageIds: ['m'] }, 'group')).body.result.records).toHaveLength(1);
    (hasPendingGroupLeaveRequest as jest.Mock).mockResolvedValue(true);
    expect((await call(true, { claim: groupClaim }, 'group')).status).toBe(403);
    (hasPendingGroupLeaveRequest as jest.Mock).mockResolvedValue(false);
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 1, protocol_version: 2, rekey_required_at: 1 });
    expect((await call(true, { claim: groupClaim }, 'group')).status).toBe(409);
    (groupChatRepository.findChat as jest.Mock).mockResolvedValue({ key_epoch: 1, protocol_version: 2, rekey_required_at: null });
    (groupChatRepository.findMessageById as jest.Mock).mockResolvedValue({ kind: 'system', deleted_at: null });
    expect((await call(true, { claim: groupClaim }, 'group')).status).toBe(403);
    (groupChatRepository.findParticipant as jest.Mock).mockResolvedValue({ is_active: false });
    expect((await call(false, { messageIds: ['m'] }, 'group')).status).toBe(403);
  });
  it('bounds list requests and isolates tenants', async () => {
    expect((await call(false, { messageIds: Array(101).fill('m') })).status).toBe(400);
    await call(true, { claim: claim() });
    await query("UPDATE message_reaction_states SET family_id='00000000-0000-0000-0000-000000000002'");
    expect((await call(false, { messageIds: ['m'] })).body.result.records).toEqual([]);
  });
});
