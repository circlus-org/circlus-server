import { resolveCallLinkPresentation } from './callSessionPresentation';

describe('resolveCallLinkPresentation', () => {
  it('classifies a call link without reading its encrypted presentation', () => {
    expect(resolveCallLinkPresentation({
      sdp_offer: JSON.stringify({
        __externalCaller: {
          admissionKind: 'call_link',
          capabilityGrant: {
            descriptor: { payload: { scope: { title: '  Support call  ' } } }
          }
        }
      })
    })).toEqual({ isTemporaryLinkCall: true });
  });

  it('does not classify an ordinary external call as a call-link call', () => {
    expect(resolveCallLinkPresentation({
      sdp_offer: JSON.stringify({
        __externalCaller: { admissionKind: 'whitelist_key' }
      })
    })).toEqual({ isTemporaryLinkCall: false });
  });
});
