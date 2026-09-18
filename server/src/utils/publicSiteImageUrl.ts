export function normalizeSelfHostedPublicSiteImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\/site-images\/[^/?#]+\/[^/?#]+$/.test(trimmed) ? trimmed : null;
}
