import { getGroupPushSenderName, getPushRecipients } from './groupChatsPush';

describe('group chat push recipients', () => {
  test('excludes sender and muted participants', () => {
    const recipients = getPushRecipients(
      [
        { identity_id: 'u1', muted: false },
        { identity_id: 'u2', muted: true },
        { identity_id: 'u3', muted: false }
      ],
      'u1'
    );

    expect(recipients).toEqual(['u3']);
  });

  test('does not expose server-side identity names', () => {
    expect(getGroupPushSenderName({ publish_identity: true, identity_name: ' Alice ' }, false)).toBeUndefined();
    expect(getGroupPushSenderName({ publish_identity: false, identity_name: 'Alice' }, false)).toBeUndefined();
  });

  test('omits names when the server disables name storage', () => {
    expect(getGroupPushSenderName({ publish_identity: true, identity_name: 'Alice' }, true)).toBeUndefined();
  });
});
