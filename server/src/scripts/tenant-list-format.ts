export type TenantListSummary = {
  familyId: string;
  circleId: string;
  name: string;
  host: string | null;
  status: string;
  activeMembers: number;
  activeGuests: number;
  totalIdentities: number;
  activeDevices: number;
};

export function formatTenantList(summaries: TenantListSummary[]): string {
  const lines = [`Circles: ${summaries.length}`];
  for (const circle of summaries) {
    lines.push(
      '---',
      `Circle name: ${circle.name}`,
      `Host: ${circle.host || '(no current domain)'}`,
      `Family ID: ${circle.familyId}`,
      `Circle ID: ${circle.circleId}`,
      `Status: ${circle.status}`,
      `Active members: ${circle.activeMembers}`,
      `Active guests: ${circle.activeGuests}`,
      `Total identities: ${circle.totalIdentities}`,
      `Active devices: ${circle.activeDevices}`
    );
  }
  return lines.join('\n');
}
