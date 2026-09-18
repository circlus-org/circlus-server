export function getPushRecipients(
  participants: Array<{ identity_id: string; muted: boolean }>,
  senderIdentityId: string
): string[] {
  return participants
    .filter((p) => p.identity_id !== senderIdentityId && !p.muted)
    .map((p) => p.identity_id);
}

export function getGroupPushSenderName(
  identity: { publish_identity?: boolean; identity_name?: string | null } | null,
  noNamesOnServer: boolean
): string | undefined {
  void identity;
  void noNamesOnServer;
  return undefined;
}
