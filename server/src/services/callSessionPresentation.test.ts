import { resolveCallLinkPresentation } from './callSessionPresentation';

describe('resolveCallLinkPresentation', () => {
  it('recovers the call-link title from the signed capability descriptor', () => {
    expect(resolveCallLinkPresentation({
      sdp_offer: JSON.stringify({
        __externalCaller: {
          admissionKind: 'call_link',
          capabilityGrant: {
            descriptor: { payload: { scope: { title: '  Support call  ' } } }
          }
        }
      })
    })).toEqual({ isTemporaryLinkCall: true, callLinkTitle: 'Support call' });
  });

  it('does not classify an ordinary external call as a call-link call', () => {
    expect(resolveCallLinkPresentation({
      sdp_offer: JSON.stringify({
        __externalCaller: { admissionKind: 'whitelist_key' }
      })
    })).toEqual({ isTemporaryLinkCall: false });
  });
});
