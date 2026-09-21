import { getSelfChatSenderDeviceId } from './directMessageDeviceMetadata';

describe('direct-message device metadata', () => {
  it('exposes the sender device for self-chat messages', () => {
    expect(getSelfChatSenderDeviceId('identity-1', 'identity-1', 'device-1')).toBe('device-1');
  });

  it('does not expose the sender device to a regular direct-message recipient', () => {
    expect(getSelfChatSenderDeviceId('identity-1', 'identity-2', 'device-1')).toBeUndefined();
  });
});
