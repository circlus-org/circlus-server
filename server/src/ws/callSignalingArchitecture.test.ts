import fs from 'fs';
import path from 'path';

const wsDir = __dirname;

function source(fileName: string): string {
  return fs.readFileSync(path.join(wsDir, fileName), 'utf8');
}

describe('call signaling architecture', () => {
  test('the public signaling facade only delegates to cohesive handlers', () => {
    const facade = source('callSignalingWsHandlers.ts');

    expect(facade).toContain('new CallOfferWsHandler');
    expect(facade).toContain('new CallAnswerWsHandler');
    expect(facade).toContain('new CallPeerMediaWsHandlers');
    expect(facade).not.toContain("../db/repositories");
    expect(facade).not.toContain('resolveDirectCommunicationAccess');
  });

  test('Circle admission and initial delivery remain in the offer handler', () => {
    const offerHandler = source('callOfferWsHandler.ts');

    expect(offerHandler).toContain('resolveDirectCommunicationAccess');
    expect(offerHandler).toContain('validateTemporaryCallDelegation');
    expect(offerHandler).toContain('callSessionRepository.create');
    expect(offerHandler).toContain('deliverInitialPush');
  });

  test('accepted-device binding remains in the answer handler', () => {
    const answerHandler = source('callAnswerWsHandler.ts');

    expect(answerHandler).toContain('bindAcceptedTargetIfAbsent');
    expect(answerHandler).toContain('markAccepted');
    expect(answerHandler).not.toContain('markConnected');
    expect(answerHandler).toContain('answered_elsewhere');
  });

  test('peer media signaling cannot decide Circle admission', () => {
    const peerMediaHandlers = source('callPeerMediaWsHandlers.ts');

    expect(peerMediaHandlers).toContain('recordCallIceCandidate');
    expect(peerMediaHandlers).toContain('handleRenegotiation');
    expect(peerMediaHandlers).toContain('handleVideoState');
    expect(peerMediaHandlers).not.toContain('resolveDirectCommunicationAccess');
    expect(peerMediaHandlers).not.toContain('directGuestRegistrationRepository');
    expect(peerMediaHandlers).not.toContain('deliverInitialPush');
  });
});
