export function getSelfChatSenderDeviceId(
  senderIdentityId: string,
  recipientIdentityId: string,
  senderDeviceId: string
): string | undefined {
  const sender = senderIdentityId.trim();
  const recipient = recipientIdentityId.trim();
  const device = senderDeviceId.trim();
  return sender && sender === recipient && device ? device : undefined;
}
