import { Router } from 'express';
import { parseLinkPreviewMetadata } from '../utils/linkPreviewMetadata';
import { verifySignature, requireActiveIdentity, requireFullCircleIdentity, getSignedPayload, type AuthRequest } from '../middleware/auth';
import { assertSafePublicHttpUrl, safeHttpFetch } from '../utils/safeHttpFetch';
import type { ApiResponse } from '../../../shared/types';

const router = Router();

const FETCH_TIMEOUT_MS = 5000;
const HTML_MAX_BYTES = 512 * 1024;
const IMAGE_MAX_BYTES = 200 * 1024;

router.post('/fetch', verifySignature, requireActiveIdentity, requireFullCircleIdentity, async (req: AuthRequest, res) => {
  const { url } = getSignedPayload<{ url?: unknown }>(req);

  if (!url || typeof url !== 'string') {
    res.json({ status: 'error', error: { code: 'invalid_request', message: 'url is required' } } satisfies ApiResponse);
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.json({ status: 'error', error: { code: 'invalid_url', message: 'Invalid URL' } } satisfies ApiResponse);
    return;
  }

  try {
    await assertSafePublicHttpUrl(parsed);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Invalid URL';
    const isPrivateUrl = rawMessage.includes('Private URLs');
    const code = isPrivateUrl ? 'forbidden_url' : 'invalid_url';
    const message = isPrivateUrl || rawMessage.includes('Only http/https')
      ? rawMessage
      : 'URL host could not be resolved';
    res.json({ status: 'error', error: { code, message } } satisfies ApiResponse);
    return;
  }

  const fetched = await safeHttpFetch(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: HTML_MAX_BYTES });
  if (!fetched) {
    res.json({ status: 'error', error: { code: 'fetch_failed', message: 'Failed to fetch URL' } } satisfies ApiResponse);
    return;
  }

  const html = fetched.body.toString('utf8');
  const { title, description, imageUrl: ogImageUrl } = parseLinkPreviewMetadata(html);

  let imageDataUrl: string | null = null;
  if (ogImageUrl) {
    try {
      const imgParsed = new URL(ogImageUrl, url);
      if (
        imgParsed.protocol === 'https:' ||
        imgParsed.protocol === 'http:'
      ) {
        const imgFetched = await safeHttpFetch(imgParsed.toString(), { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: IMAGE_MAX_BYTES });
        if (imgFetched) {
          const mimeType = imgFetched.contentType.split(';')[0].trim();
          if (mimeType.startsWith('image/')) {
            imageDataUrl = `data:${mimeType};base64,${imgFetched.body.toString('base64')}`;
          }
        }
      }
    } catch {
      // ignore image errors — title/description still useful
    }
  }

  res.json({
    status: 'ok',
    result: { title, description, imageDataUrl, fetchedUrl: url }
  } satisfies ApiResponse<{ title: string | null; description: string | null; imageDataUrl: string | null; fetchedUrl: string }>);
});

export default router;
