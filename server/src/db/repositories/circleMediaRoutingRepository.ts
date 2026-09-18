import { query } from '../index';

export type CircleMediaRoutingStrategy = 'server_default' | 'fixed';

export interface DBCircleMediaRoutingSettings {
  family_id: string;
  strategy: CircleMediaRoutingStrategy;
  turn_cluster_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export class CircleMediaRoutingRepository {
  async findByFamilyId(familyId: string): Promise<DBCircleMediaRoutingSettings | null> {
    const result = await query<DBCircleMediaRoutingSettings>(
      `SELECT family_id, strategy, turn_cluster_id, created_at, updated_at
       FROM circle_media_routing_settings
       WHERE family_id = $1
       LIMIT 1`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async upsert(input: {
    familyId: string;
    strategy: CircleMediaRoutingStrategy;
    turnClusterId: string | null;
  }): Promise<DBCircleMediaRoutingSettings> {
    const result = await query<DBCircleMediaRoutingSettings>(
      `INSERT INTO circle_media_routing_settings (
         family_id, strategy, turn_cluster_id
       ) VALUES ($1, $2, $3)
       ON CONFLICT (family_id) DO UPDATE
       SET strategy = EXCLUDED.strategy,
           turn_cluster_id = EXCLUDED.turn_cluster_id,
           updated_at = NOW()
       RETURNING family_id, strategy, turn_cluster_id, created_at, updated_at`,
      [input.familyId, input.strategy, input.turnClusterId]
    );
    return result.rows[0];
  }
}

export const circleMediaRoutingRepository = new CircleMediaRoutingRepository();
