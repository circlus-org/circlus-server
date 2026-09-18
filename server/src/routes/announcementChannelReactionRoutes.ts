import { Router, type NextFunction, type Response } from 'express';
import { transaction } from '../db';
import { verifySignature, requireActiveIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { reliableOperation } from '../services/reliableOperation';
import { validChannelReactionWrite, canReplaceChannelReactions } from '../../../shared/channelReactions';
const router = Router();
class Rejected extends Error { constructor(readonly status: number, message: string) { super(message); } }
type ChannelReactionPayload = {
  enabled?: unknown;
  postIds?: unknown;
  postId?: unknown;
  cursor?: unknown;
  revision?: unknown;
  emojis?: unknown;
};
export function channelReactionHandler(action: 'list' | 'set' | 'settings' | 'readers') {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const familyId = req.familyId!;
      const actor = req.identity!.identityId;
      const channelId = req.params.channelId;
      const payload = getSignedPayload<ChannelReactionPayload>(req);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Rejected(400,'Invalid payload');
      const result = await transaction(async db => {
        const channel = (await db.query(`SELECT owner_identity_id,reactions_enabled FROM announcement_channels
          WHERE family_id=$1 AND channel_id=$2 AND status='active' ${action === 'settings' ? 'FOR UPDATE' : 'FOR SHARE'}`, [familyId,channelId])).rows[0];
        if (!channel) throw new Rejected(404,'Channel unavailable');
        const owner = channel.owner_identity_id === actor;
        if ((action === 'settings' || action === 'readers') && !owner) throw new Rejected(403,'Only the author can access this information');
        if (!owner) {
          const subscription = (await db.query(`SELECT status FROM announcement_channel_subscriptions
            WHERE family_id=$1 AND channel_id=$2 AND subscriber_identity_id=$3 FOR SHARE`, [familyId,channelId,actor])).rows[0];
          if (subscription?.status !== 'active') throw new Rejected(403,'Active subscription required');
        }
        if (action === 'settings') {
          if (typeof payload.enabled !== 'boolean') throw new Rejected(400,'Invalid setting');
          await db.query('UPDATE announcement_channels SET reactions_enabled=$3 WHERE family_id=$1 AND channel_id=$2',[familyId,channelId,payload.enabled]);
          return { enabled: payload.enabled };
        }
        const postId = typeof payload.postId === 'string' ? payload.postId : '';
        const ids = action === 'list' ? payload.postIds : [postId];
        if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Rejected(400,'Invalid post IDs');
        const posts = (await db.query(`SELECT post_id FROM announcement_channel_posts WHERE family_id=$1 AND channel_id=$2
          AND post_id=ANY($3::text[]) AND deleted_at IS NULL FOR SHARE`,[familyId,channelId,ids])).rows;
        const available = posts.map(row => row.post_id as string);
        if (action !== 'list' && !available.includes(postId)) throw new Rejected(404,'Post unavailable');
        if (action === 'set') {
          if (!validChannelReactionWrite(payload)) throw new Rejected(400,'Invalid reaction set');
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([familyId,channelId,postId,actor])]);
          const previous = (await db.query(`SELECT revision,emojis FROM announcement_channel_reactions
            WHERE family_id=$1 AND channel_id=$2 AND post_id=$3 AND actor_identity_id=$4`,[familyId,channelId,postId,actor])).rows[0];
          const revision = Number(previous?.revision || 0);
          const same = revision === payload.revision && JSON.stringify(previous.emojis) === JSON.stringify(payload.emojis);
          if (!same) {
            if (payload.revision !== revision + 1) throw new Rejected(409,'Reaction changed on another device');
            if (!canReplaceChannelReactions(channel.reactions_enabled, previous?.emojis || [], payload.emojis)) throw new Rejected(403,'New reactions are disabled');
            await db.query(`INSERT INTO announcement_channel_reactions(family_id,channel_id,post_id,actor_identity_id,revision,emojis)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(family_id,channel_id,post_id,actor_identity_id)
              DO UPDATE SET revision=EXCLUDED.revision,emojis=EXCLUDED.emojis`,[familyId,channelId,postId,actor,payload.revision,payload.emojis]);
          }
        }
        if (action === 'readers') {
          const cursor = typeof payload.cursor === 'string' ? payload.cursor : '';
          const rows = (await db.query(`SELECT actor_identity_id,emojis FROM announcement_channel_reactions
            WHERE family_id=$1 AND channel_id=$2 AND post_id=$3 AND cardinality(emojis)>0 AND actor_identity_id>$4
            ORDER BY actor_identity_id LIMIT 51`,[familyId,channelId,postId,cursor])).rows;
          return { readers: rows.slice(0,50).map(row => ({ identityId: row.actor_identity_id, emojis: row.emojis })),
            nextCursor: rows.length > 50 ? rows[49].actor_identity_id : null };
        }
        // No other reader's identity, signature or individual selection leaves this endpoint.
        // One SQL snapshot keeps own revision/selection consistent with the counts.
        const states = (await db.query(`WITH counts AS (
          SELECT post_id,emoji,COUNT(*)::int AS count FROM announcement_channel_reactions,unnest(emojis) AS emoji
          WHERE family_id=$1 AND channel_id=$2 AND post_id=ANY($3::text[]) GROUP BY post_id,emoji
        ), totals AS (
          SELECT post_id,jsonb_agg(jsonb_build_object('emoji',emoji,'count',count) ORDER BY emoji) AS counts
          FROM counts GROUP BY post_id
        ) SELECT p.post_id,COALESCE(own.revision,0) AS revision,COALESCE(own.emojis,ARRAY[]::text[]) AS mine,
          COALESCE(totals.counts,'[]'::jsonb) AS counts FROM unnest($3::text[]) AS p(post_id)
          LEFT JOIN announcement_channel_reactions own ON own.family_id=$1 AND own.channel_id=$2
            AND own.post_id=p.post_id AND own.actor_identity_id=$4
          LEFT JOIN totals ON totals.post_id=p.post_id`,[familyId,channelId,available,actor])).rows;
        return { enabled: channel.reactions_enabled, states: states.map(row => ({
          postId:row.post_id,revision:Number(row.revision),mine:row.mine,counts:row.counts,
        })) };
      });
      return res.json({status:'ok',result});
    } catch (error) {
      if (error instanceof Rejected) return res.status(error.status).json({status:'error',error:{code:error.status === 409 ? 'CONFLICT' : error.status === 403 ? 'FORBIDDEN' : error.status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST',message:error.message}});
      next(error);
    }
  };
}
for (const action of ['list','set','readers'] as const) router.post(`/:channelId/reactions/${action}`,verifySignature,requireActiveIdentity,channelReactionHandler(action));
router.post('/:channelId/reactions/settings',verifySignature,requireActiveIdentity,reliableOperation(channelReactionHandler('settings'),req => `channel-reactions-settings:${req.params.channelId}`));
export default router;
