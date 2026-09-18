import fs from 'node:fs';
import path from 'node:path';

describe('server-management Circle summaries', () => {
  it('aggregates active channels without disclosing the owner name', () => {
    const repository = fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/repositories/familyConfigRepository.ts'),
      'utf8'
    );
    const route = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/serverAdmin.ts'),
      'utf8'
    );

    expect(repository).toMatch(/COUNT\(\*\) AS active_channel_count[\s\S]*announcement_channels[\s\S]*channel\.status = 'active'/);
    expect(repository).toMatch(/owner_identity\.identity_name AS owner_identity_name/);
    expect(route).toMatch(/activeChannelCount: tenant\.active_channel_count/);
    expect(route).toMatch(/ownerName: null/);
  });
});
