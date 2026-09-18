import { transaction, pool } from '../index';
import { createInvite } from './inviteRepository.queries';
import type { EncryptedBlob } from '../../../../shared/types';
import type { LinkCapabilityDescriptor, LinkCapabilityMode } from '../../../../shared/linkCapability';
import type { LinkCapabilityRevocation } from '../../../../shared/linkCapability';
import { directGuestLinkRepository } from './directGuestLinkRepository';
import { CALL_LINK_DIRECT_GUEST_PERMISSIONS } from '../../../../shared/callLinkInvitation';

export type CallLinkRecord = {
  call_link_id: string;
  family_id: string;
  target_identity_id: string;
  created_by: string;
  secret_hash: string;
  title: string | null;
  suggest_join_after_call: boolean;
  join_invite_id: string | null;
  join_invite_token: string | null;
  join_invite_status: string | null;
  direct_guest_link_id: string | null;
  direct_guest_link_status: string | null;
  direct_guest_capability_descriptor: LinkCapabilityDescriptor | null;
  status: 'active' | 'revoked' | 'expired';
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  capability_id: string | null;
  capability_public_key: string | null;
  capability_mode: LinkCapabilityMode | null;
  capability_descriptor: LinkCapabilityDescriptor | null;
  encrypted_secret: EncryptedBlob | null;
};

export type OwnedCallLinkRecord = CallLinkRecord & {
  join_invite_title: string | null;
  join_invite_expires_at: Date | null;
};

export class CallLinkRepository {
  async createWithOptionalInvite(params: {
    familyId: string;
    identityId: string;
    role?: string;
    callLinkId: string;
    secretHash: string;
    title: string;
    suggestJoinAfterCall: boolean;
    expiresAt: Date;
    joinInviteId: string | null;
    joinInviteToken: string | null;
    joinInviteExpiresAt: Date | null;
    capabilityId: string;
    capabilityMode: LinkCapabilityMode;
    capabilityDescriptor: LinkCapabilityDescriptor;
    encryptedSecret: EncryptedBlob;
    directGuestInvitation?: {
      linkId: string;
      capabilityDescriptor: LinkCapabilityDescriptor;
      presentationTitle: string | null;
    } | null;
  }): Promise<{
    ok: boolean;
    suggestJoinAfterCall?: boolean;
    joinInviteId?: string | null;
    joinInviteToken?: string | null;
    directGuestLinkId?: string | null;
  }> {
    return transaction(async (client) => {
      let finalSuggestJoinAfterCall = params.suggestJoinAfterCall;

      if (params.suggestJoinAfterCall && params.joinInviteId && params.joinInviteToken && params.joinInviteExpiresAt) {
        const permission = await client.query<{ role: string | null; can_create_invites: boolean }>(
          `SELECT role, can_create_invites
             FROM identities
            WHERE family_id = $1
              AND identity_id = $2
              AND status = 'active'
            FOR SHARE`,
          [params.familyId, params.identityId]
        );
        const identity = permission.rows[0];
        if (!identity || (identity.role !== 'owner' && (identity.role !== 'member' || !identity.can_create_invites))) {
          return { ok: false };
        }
        await createInvite.run({
          inviteId: params.joinInviteId,
          token: params.joinInviteToken,
          familyId: params.familyId,
          createdBy: params.identityId,
          expiresAt: params.joinInviteExpiresAt,
          maxUses: 1,
        }, client);
        await client.query(
          `UPDATE invites
           SET capability_id = $1,
               capability_public_key = $2,
               capability_mode = 'single-use',
               capability_descriptor = $3::jsonb,
               encrypted_secret = $4::jsonb
           WHERE family_id = $5 AND invite_id = $6`,
          [
            params.capabilityId,
            params.capabilityDescriptor.payload.capabilityPublicKey.value,
            JSON.stringify(params.capabilityDescriptor),
            JSON.stringify(params.encryptedSecret),
            params.familyId,
            params.joinInviteId
          ]
        );
      } else {
        finalSuggestJoinAfterCall = false;
      }

      if (params.directGuestInvitation) {
        const permissions = CALL_LINK_DIRECT_GUEST_PERMISSIONS;
        await directGuestLinkRepository.create({
          linkId: params.directGuestInvitation.linkId,
          familyId: params.familyId,
          hostIdentityId: params.identityId,
          createdByIdentityId: params.identityId,
          secretHash: params.capabilityId,
          encryptedSecret: params.encryptedSecret,
          ...permissions,
          title: params.title,
          presentationTitle: params.directGuestInvitation.presentationTitle,
          maxUses: 1,
          capabilityId: params.capabilityId,
          capabilityMode: 'single-use',
          capabilityDescriptor: params.directGuestInvitation.capabilityDescriptor,
          expiresAt: params.expiresAt,
        }, client);
      }

      await client.query(
        `INSERT INTO call_links (
           call_link_id,
           family_id,
           target_identity_id,
           created_by,
           secret_hash,
           title,
           suggest_join_after_call,
           join_invite_id,
           join_invite_token,
           direct_guest_link_id,
           expires_at,
           capability_id,
           capability_public_key,
           capability_mode,
           capability_descriptor,
           encrypted_secret
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)`,
        [
          params.callLinkId,
          params.familyId,
          params.identityId,
          params.identityId,
          params.secretHash,
          params.title,
          finalSuggestJoinAfterCall,
          finalSuggestJoinAfterCall ? params.joinInviteId : null,
          finalSuggestJoinAfterCall ? params.joinInviteToken : null,
          params.directGuestInvitation?.linkId || null,
          params.expiresAt,
          params.capabilityId,
          params.capabilityDescriptor.payload.capabilityPublicKey.value,
          params.capabilityMode,
          JSON.stringify(params.capabilityDescriptor),
          JSON.stringify(params.encryptedSecret)
        ]
      );

      return {
        ok: true,
        suggestJoinAfterCall: finalSuggestJoinAfterCall,
        joinInviteId: finalSuggestJoinAfterCall ? params.joinInviteId : null,
        joinInviteToken: finalSuggestJoinAfterCall ? params.joinInviteToken : null,
        directGuestLinkId: params.directGuestInvitation?.linkId || null,
      };
    });
  }

  async findById(familyId: string, callLinkId: string): Promise<CallLinkRecord | null> {
    const result = await pool.query<CallLinkRecord>(
      `SELECT call_link.call_link_id, call_link.target_identity_id, call_link.title,
              call_link.suggest_join_after_call, call_link.join_invite_id,
              CASE WHEN invite.status = 'active' AND invite.expires_at > NOW()
                   THEN call_link.join_invite_token ELSE NULL END AS join_invite_token,
              invite.status AS join_invite_status, call_link.direct_guest_link_id,
              direct_guest.status AS direct_guest_link_status,
              direct_guest.capability_descriptor AS direct_guest_capability_descriptor,
              call_link.expires_at, call_link.status, call_link.family_id, call_link.created_by,
              call_link.secret_hash, call_link.created_at, call_link.last_used_at, call_link.revoked_at
              , call_link.capability_id, call_link.capability_public_key,
              call_link.capability_mode, call_link.capability_descriptor, call_link.encrypted_secret
       FROM call_links call_link
       LEFT JOIN invites invite
         ON invite.family_id = call_link.family_id
        AND invite.invite_id = call_link.join_invite_id
       LEFT JOIN direct_guest_links direct_guest
         ON direct_guest.family_id = call_link.family_id
        AND direct_guest.link_id = call_link.direct_guest_link_id
       WHERE call_link.family_id = $1 AND call_link.call_link_id = $2
       LIMIT 1`,
      [familyId, callLinkId]
    );
    return result.rows[0] || null;
  }

  async findOwned(familyId: string, identityId: string): Promise<OwnedCallLinkRecord[]> {
    await pool.query(
      `UPDATE call_links
       SET status = 'expired'
       WHERE family_id = $1
         AND created_by = $2
         AND status = 'active'
         AND expires_at <= NOW()`,
      [familyId, identityId]
    );
    const result = await pool.query<OwnedCallLinkRecord>(
      `SELECT call_link.call_link_id, call_link.family_id, call_link.target_identity_id,
              call_link.created_by, call_link.secret_hash, call_link.title,
              call_link.suggest_join_after_call, call_link.join_invite_id,
              call_link.join_invite_token, call_link.status, call_link.created_at,
              call_link.direct_guest_link_id,
              call_link.expires_at, call_link.last_used_at, call_link.revoked_at,
              call_link.capability_id, call_link.capability_public_key,
              call_link.capability_mode, call_link.capability_descriptor, call_link.encrypted_secret,
              invite.status AS join_invite_status, invite.title AS join_invite_title,
              invite.expires_at AS join_invite_expires_at,
              direct_guest.status AS direct_guest_link_status,
              direct_guest.capability_descriptor AS direct_guest_capability_descriptor
       FROM call_links call_link
       LEFT JOIN invites invite
         ON invite.family_id = call_link.family_id
        AND invite.invite_id = call_link.join_invite_id
       LEFT JOIN direct_guest_links direct_guest
         ON direct_guest.family_id = call_link.family_id
        AND direct_guest.link_id = call_link.direct_guest_link_id
       WHERE call_link.family_id = $1 AND call_link.created_by = $2
       ORDER BY call_link.created_at DESC`,
      [familyId, identityId]
    );
    return result.rows;
  }

  async setCapabilityRevocation(
    familyId: string,
    callLinkId: string,
    revocation: LinkCapabilityRevocation
  ): Promise<void> {
    await pool.query(
      `UPDATE call_links
       SET capability_revocation = $1::jsonb
       WHERE family_id = $2 AND call_link_id = $3`,
      [JSON.stringify(revocation), familyId, callLinkId]
    );
  }

  async revokeOwned(params: {
    familyId: string;
    identityId: string;
    callLinkId: string;
    unlimitedInvites: boolean;
  }): Promise<
    | { ok: true; row: OwnedCallLinkRecord; remaining: number | null }
    | { ok: false; reason: 'not_found' | 'not_active' }
  > {
    return transaction(async (client) => {
      const linkResult = await client.query<OwnedCallLinkRecord>(
        `SELECT call_link.*, invite.status AS join_invite_status,
                invite.title AS join_invite_title, invite.expires_at AS join_invite_expires_at,
                direct_guest.status AS direct_guest_link_status,
                direct_guest.capability_descriptor AS direct_guest_capability_descriptor
         FROM call_links call_link
         LEFT JOIN invites invite
           ON invite.family_id = call_link.family_id
          AND invite.invite_id = call_link.join_invite_id
         LEFT JOIN direct_guest_links direct_guest
           ON direct_guest.family_id = call_link.family_id
          AND direct_guest.link_id = call_link.direct_guest_link_id
         WHERE call_link.family_id = $1
           AND call_link.call_link_id = $2
           AND call_link.created_by = $3
         FOR UPDATE OF call_link`,
        [params.familyId, params.callLinkId, params.identityId]
      );
      const row = linkResult.rows[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      if (row.status !== 'active' || row.expires_at.getTime() <= Date.now()) {
        if (row.status === 'active') {
          await client.query(
            `UPDATE call_links SET status = 'expired'
             WHERE family_id = $1 AND call_link_id = $2`,
            [params.familyId, params.callLinkId]
          );
        }
        return { ok: false as const, reason: 'not_active' as const };
      }

      const revoked = await client.query<OwnedCallLinkRecord>(
        `UPDATE call_links
         SET status = 'revoked', revoked_at = NOW()
         WHERE family_id = $1 AND call_link_id = $2
         RETURNING *`,
        [params.familyId, params.callLinkId]
      );

      let remaining: number | null = null;
      if (row.join_invite_id) {
        const inviteResult = await client.query<{ used_count: number; status: string }>(
          `UPDATE invites
           SET status = 'revoked'
           WHERE family_id = $1
             AND invite_id = $2
             AND status = 'active'
           RETURNING used_count, status`,
          [params.familyId, row.join_invite_id]
        );
        void inviteResult;
      }
      if (row.direct_guest_link_id) {
        await client.query(
          `UPDATE direct_guest_links
           SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
           WHERE family_id = $1 AND link_id = $2 AND status = 'active'`,
          [params.familyId, row.direct_guest_link_id]
        );
      }

      return {
        ok: true as const,
        row: {
          ...revoked.rows[0],
          join_invite_status: row.join_invite_id && row.join_invite_status === 'active'
            ? 'revoked'
            : row.join_invite_status,
          join_invite_title: row.join_invite_title,
          join_invite_expires_at: row.join_invite_expires_at,
          direct_guest_link_status: row.direct_guest_link_id && row.direct_guest_link_status === 'active'
            ? 'revoked'
            : row.direct_guest_link_status,
          direct_guest_capability_descriptor: row.direct_guest_capability_descriptor,
        },
        remaining,
      };
    });
  }
}

export const callLinkRepository = new CallLinkRepository();
