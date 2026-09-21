import fs from 'node:fs';
import path from 'node:path';
import groupChatMembershipRoutes from './groupChatMembershipRoutes';

describe('group chat membership route boundary', () => {
  it('registers the complete membership endpoint set', () => {
    const paths = (groupChatMembershipRoutes as unknown as {
      stack: Array<{ route?: { path?: string } }>;
    }).stack.flatMap((layer) => layer.route?.path ? [layer.route.path] : []);

    expect(paths).toEqual([
      '/:chatId/participants/list'
    ]);
  });

  it('keeps membership handlers out of the parent group chat router', () => {
    const parentSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'routes', 'groupChats.ts'),
      'utf8'
    );

    expect(parentSource).toContain('router.use(groupChatMembershipRoutes)');
    expect(parentSource).not.toContain("router.post('/:chatId/participants");
    expect(parentSource).not.toContain("router.post('/:chatId/owner");
    expect(parentSource).not.toContain("router.post('/:chatId/leave");
  });
});
