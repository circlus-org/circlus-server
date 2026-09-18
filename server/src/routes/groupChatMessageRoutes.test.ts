import fs from 'node:fs';
import path from 'node:path';
import groupChatMessageRoutes from './groupChatMessageRoutes';

describe('group chat message route boundary', () => {
  it('registers the complete message endpoint set', () => {
    const paths = (groupChatMessageRoutes as unknown as {
      stack: Array<{ route?: { path?: string } }>;
    }).stack.flatMap((layer) => layer.route?.path ? [layer.route.path] : []);

    expect(paths).toEqual([
      '/:chatId/reactions/list',
      '/:chatId/reactions/set',
      '/:chatId/messages/send',
      '/:chatId/messages/list',
      '/:chatId/messages/:messageId/readers',
      '/:chatId/messages/:messageId/edit',
      '/:chatId/messages/:messageId/delete',
      '/:chatId/messages/clear-boundary',
      '/:chatId/messages/clear',
      '/:chatId/messages/read'
    ]);
  });

  it('keeps message handlers out of the parent group chat router', () => {
    const parentSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src', 'routes', 'groupChats.ts'),
      'utf8'
    );

    expect(parentSource).toContain('router.use(groupChatMessageRoutes)');
    expect(parentSource).not.toMatch(/router\.post\('\/:chatId\/messages\//);
  });
});
