export const CIRCLE_SITE_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const CIRCLE_SITE_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export const CIRCLE_SITE_VIDEO_POSTER_ALT_PREFIX = 'circlus-video-poster:';

export type CircleSiteAssetKind = 'image' | 'download';

const imageMimeTypes = new Set<string>(CIRCLE_SITE_IMAGE_MIME_TYPES);
const videoMimeTypes = new Set<string>(CIRCLE_SITE_VIDEO_MIME_TYPES);

export function isCircleSiteImageMimeType(value: string | null | undefined): boolean {
  return imageMimeTypes.has(String(value || '').trim().toLowerCase());
}

export function isCircleSiteVideoMimeType(value: string | null | undefined): boolean {
  return videoMimeTypes.has(String(value || '').trim().toLowerCase());
}

export function isCircleSiteVideoPosterAltText(value: string | null | undefined): boolean {
  return String(value || '').startsWith(CIRCLE_SITE_VIDEO_POSTER_ALT_PREFIX);
}

export function getCircleSiteVideoPosterTarget(value: string | null | undefined): string | null {
  if (!isCircleSiteVideoPosterAltText(value)) return null;
  const target = String(value).slice(CIRCLE_SITE_VIDEO_POSTER_ALT_PREFIX.length).trim();
  return target || null;
}
