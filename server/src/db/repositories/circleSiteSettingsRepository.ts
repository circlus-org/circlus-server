import { query } from '../index';

export type CircleSiteTheme = 'default';

export interface DBCircleSiteSettings {
  family_id: string;
  enabled: boolean;
  indexing_enabled: boolean;
  site_title: string | null;
  site_description: string | null;
  cover_image_url: string | null;
  theme: CircleSiteTheme;
  created_at: Date;
  updated_at: Date;
}

export class CircleSiteSettingsRepository {
  async findByFamilyId(familyId: string): Promise<DBCircleSiteSettings | null> {
    const result = await query<DBCircleSiteSettings>(
      `SELECT *
       FROM circle_site_settings
       WHERE family_id = $1
       LIMIT 1`,
      [familyId]
    );
    return result.rows[0] || null;
  }

  async upsert(input: {
    familyId: string;
    enabled: boolean;
    indexingEnabled: boolean;
    siteTitle?: string | null;
    siteDescription?: string | null;
    theme?: CircleSiteTheme;
  }): Promise<DBCircleSiteSettings> {
    const result = await query<DBCircleSiteSettings>(
      `INSERT INTO circle_site_settings (
         family_id, enabled, indexing_enabled, site_title, site_description, theme
       ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'default'))
       ON CONFLICT (family_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           indexing_enabled = EXCLUDED.indexing_enabled,
           site_title = EXCLUDED.site_title,
           site_description = EXCLUDED.site_description,
           theme = EXCLUDED.theme,
           updated_at = NOW()
       RETURNING *`,
      [
        input.familyId,
        input.enabled,
        input.indexingEnabled,
        input.siteTitle ?? null,
        input.siteDescription ?? null,
        input.theme ?? null,
      ]
    );
    return result.rows[0];
  }
}

export const circleSiteSettingsRepository = new CircleSiteSettingsRepository();
