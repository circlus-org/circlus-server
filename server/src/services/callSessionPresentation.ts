type StoredExternalCaller = {
  admissionKind?: unknown;
  capabilityGrant?: {
    descriptor?: {
      payload?: {
        scope?: Record<string, unknown>;
      };
    };
  };
};

export type CallLinkPresentation = {
  isTemporaryLinkCall: boolean;
  callLinkTitle?: string;
};

export function resolveCallLinkPresentation(
  callSession: { sdp_offer?: string | null } | null | undefined
): CallLinkPresentation {
  try {
    const offer = callSession?.sdp_offer ? JSON.parse(callSession.sdp_offer) : null;
    const externalCaller = offer?.__externalCaller as StoredExternalCaller | undefined;
    if (externalCaller?.admissionKind !== 'call_link') {
      return { isTemporaryLinkCall: false };
    }
    return { isTemporaryLinkCall: true };
  } catch {
    return { isTemporaryLinkCall: false };
  }
}
