import fs from 'node:fs';
import path from 'node:path';

function source(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', file), 'utf8');
}

describe('retired pre-public endpoints', () => {
  it('does not expose protocol-v1 group mutations', () => {
    const groupSources = [
      source('groupChats.ts'),
      source('groupChatMembershipRoutes.ts'),
      source('groupChatKeyRoutes.ts'),
    ].join('\n');
    for (const pathFragment of [
      'participants\\:add',
      'participants\\:remove',
      'owner\\:transfer',
      'leave-check',
      "router.post('/:chatId/leave'",
      "router.post('/:chatId/rename'",
      'keys/claim-or-publish',
    ]) {
      expect(groupSources).not.toContain(pathFragment);
    }
  });

  it('does not expose duplicate config mutation or public identity lookup', () => {
    expect(source('adminConfigRoutes.ts')).not.toContain('/family-config/upsert');
    expect(source('authIdentityLookupRoutes.ts')).not.toContain('/identity/lookup');
  });

  it('uses purpose-specific presence and membership directory routes', () => {
    const identities = source('identities.ts');
    const membership = source('circleMembership.ts');
    expect(identities).toContain("'/presence-settings'");
    expect(identities).not.toContain("'/settings'");
    expect(identities).not.toContain("'/published'");
    expect(membership).toContain("'/directory'");
  });
});
