type StoredExternalCaller = {
  admissionKind?: unknown;
  callLinkTitle?: unknown;
  capabilityGrant?: {
    descriptor?: {
      payload?: {
        scope?: {
          title?: unknown;
        };
      };
    };
  };
};

export type CallLinkPresentation = {
  isTemporaryLinkCall: boolean;
  callLinkTitle?: string;
};

function cleanCallLinkTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, 120) || undefined;
}

export function resolveCallLinkPresentation(
  callSession: { sdp_offer?: string | null } | null | undefined
): CallLinkPresentation {
  try {
    const offer = callSession?.sdp_offer ? JSON.parse(callSession.sdp_offer) : null;
    const externalCaller = offer?.__externalCaller as StoredExternalCaller | undefined;
    if (externalCaller?.admissionKind !== 'call_link') {
      return { isTemporaryLinkCall: false };
    }
    return {
      isTemporaryLinkCall: true,
      callLinkTitle: cleanCallLinkTitle(externalCaller.callLinkTitle)
        || cleanCallLinkTitle(externalCaller.capabilityGrant?.descriptor?.payload?.scope?.title)
    };
  } catch {
    return { isTemporaryLinkCall: false };
  }
}
