import { readEndedCallForResume } from './endedCallResume';

const actor = { familyId: 'circle', identityId: 'guest' };
function harness(state = 'ended', participants = ['guest', 'owner']) {
  return {
    findSession: jest.fn(async () => ({ state, participants })),
    findHistory: jest.fn(async (): Promise<{ final_reason: string | null } | null> => ({
      final_reason: 'signaling_disconnected'
    }))
  };
}

describe('resuming a call after its terminal event was missed', () => {
  it.each(['ended', 'expired', 'failed'])('returns the persisted outcome for a participant of a %s call', async state => {
    const dependencies = harness(state);
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).resolves.toEqual({
      callSessionId: 'call-1', reason: 'signaling_disconnected'
    });
    expect(dependencies.findSession).toHaveBeenCalledWith('circle', 'call-1');
    expect(dependencies.findHistory).toHaveBeenCalledWith('circle', 'call-1');
  });

  it.each(['new', 'ringing', 'accepted', 'active'])('does not terminate a %s call', async state => {
    const dependencies = harness(state);
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).resolves.toBeNull();
    expect(dependencies.findHistory).not.toHaveBeenCalled();
  });

  it('does not read or disclose history to someone outside the call', async () => {
    const dependencies = harness('ended', ['another-guest', 'owner']);
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).resolves.toBeNull();
    expect(dependencies.findHistory).not.toHaveBeenCalled();
  });

  it('does not infer termination from a missing session', async () => {
    const dependencies = { ...harness(), findSession: jest.fn(async () => null) };
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).resolves.toBeNull();
    expect(dependencies.findHistory).not.toHaveBeenCalled();
  });

  it('releases a confirmed ended call even when the history outcome has not been written yet', async () => {
    const dependencies = harness();
    dependencies.findHistory.mockResolvedValue(null);
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).resolves.toEqual({
      callSessionId: 'call-1', reason: 'call_not_found'
    });
  });

  it('does not turn a database failure into a terminal outcome', async () => {
    const dependencies = harness();
    dependencies.findSession.mockRejectedValue(new Error('database unavailable'));
    await expect(readEndedCallForResume(actor, 'call-1', dependencies)).rejects.toThrow('database unavailable');
    expect(dependencies.findHistory).not.toHaveBeenCalled();
  });
});
