/** A reconnecting participant can miss the terminal event while signaling is down.
 * Recover that outcome from this Circle's records; never reveal another caller's history.
 */
export async function readEndedCallForResume(
  actor: { familyId: string; identityId: string },
  callSessionId: string,
  dependencies: {
    findSession: (familyId: string, callSessionId: string) => Promise<{
      state: string; participants: string[];
    } | null>;
    findHistory: (familyId: string, callSessionId: string) => Promise<{ final_reason: string | null } | null>;
  }
): Promise<{ callSessionId: string; reason: string } | null> {
  const session = await dependencies.findSession(actor.familyId, callSessionId);
  if (!session || !session.participants.includes(actor.identityId)) return null;
  if (!['ended', 'expired', 'failed'].includes(session.state)) return null;
  const history = await dependencies.findHistory(actor.familyId, callSessionId);
  return { callSessionId, reason: history?.final_reason || 'call_not_found' };
}
