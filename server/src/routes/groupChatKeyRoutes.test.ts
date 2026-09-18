import fs from 'node:fs';
import path from 'node:path';
import groupChatKeyRoutes from './groupChatKeyRoutes';

describe('group chat key route boundary', () => {
  it('registers the complete key-management endpoint set', () => {
    const paths = (groupChatKeyRoutes as unknown as {
      stack: Array<{ route?: { path?: string } }>;
    }).stack.flatMap((layer) => layer.route?.path ? [layer.route.path] : []);

    expect(paths).toEqual([
      '/:chatId/keys/publish',
      '/:chatId/keys/claim-or-publish',
      '/:chatId/keys/fetch',
      '/:chatId/keys/coverage'
    ]);
  });

  it('keeps key-management handlers out of the parent group chat router', () => {
    const parentSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'routes', 'groupChats.ts'),
      'utf8'
    );

    expect(parentSource).toContain('router.use(groupChatKeyRoutes)');
    expect(parentSource).not.toMatch(/router\.post\('\/:chatId\/keys\//);
  });
});
