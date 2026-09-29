import { accessResource } from '@shared/accessOperations';

describe('direct guest chat access operations', () => {
  it('binds channel subscriber offers and chat ending to a registration', () => {
    expect(accessResource(
      'direct-guest-registrations:chat-offer',
      '/direct-guest-links/registrations/reg-1/chat-offer',
      { channelId: 'channel-1' },
      'host-1'
    )).toBe('access:["guest-access","host-1","reg-1"]');
    expect(accessResource(
      'direct-guest-registrations:chat-end',
      '/direct-guest-links/registrations/reg-1/chat-end',
      { hostIdentityId: 'host-1' },
      'guest-1'
    )).toBe('access:["guest-access","guest-1","reg-1"]');
  });

  it('binds accept and decline to the same offer and guest', () => {
    for (const action of ['accept', 'decline']) {
      expect(accessResource(
        `direct-guest-chat-offers:${action}`,
        `/direct-guest-links/chat-offers/offer-1/${action}`,
        {},
        'guest-1'
      )).toBe('access:["guest-chat-offer","guest-1","offer-1"]');
    }
    expect(() => accessResource(
      'direct-guest-chat-offers:accept',
      '/direct-guest-links/chat-offers/offer-2/accept',
      {},
      'guest-1'
    )).not.toThrow();
    expect(() => accessResource(
      'direct-guest-chat-offers:accept',
      '/direct-guest-links/chat-offers/offer-1/decline',
      {},
      'guest-1'
    )).toThrow();
  });
});
