import { routeLogger } from '../utils/routeLogger';
import { Router, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { TenancyRequest } from '../middleware/tenancy';
import { getRequestHost } from '../middleware/tenancy';
import { setPublicSiteSecurityHeaders } from '../middleware/security';
import {
  circleSitePublicationAssetRepository,
  circleSiteSettingsRepository,
} from '../db/repositories';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import { isBlockedManagedHost, getPublicSiteProductUrl } from '../utils/publicSiteDomainPolicy';
import { buildBlockedDomainPlaceholderHtml, buildDisabledSitePlaceholderHtml } from '../services/publicSiteRenderer';
import { isCircleSiteImageMimeType, isCircleSiteVideoMimeType } from '../../../shared/circleSiteAssets';

const router = Router();

// Theme font files shipped with the server (see publicSiteFonts.ts). The
// server always runs with server/ as its working directory (npm scripts and
// the Docker WORKDIR), matching how attachment storage resolves its paths.
const SITE_FONTS_DIR = path.resolve(process.cwd(), 'assets', 'site-fonts');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function sendHtml(res: Response, status: number, html: string) {
  res.status(status).type('html').send(html);
}

function sendNoindexPlaceholder(res: Response) {
  sendHtml(res, 200, buildBlockedDomainPlaceholderHtml(getPublicSiteProductUrl()));
}

function contentDispositionFileName(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseVideoByteRange(value: unknown, size: number): { start: number; end: number } | null | false {
  const header = String(value || '').trim();
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) return false;
  return { start, end };
}

/** Serves the generated static site for the current family, or the appropriate
 * placeholder/404s for blocked managed domains and disabled sites. Never
 * intercepts `/api/*`, `/ws`, or `/health` — those are mounted before this
 * router and Express matches them first, but the guard below is explicit
 * defense in depth. */
router.use(async (req: TenancyRequest, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ws' || req.path === '/health') {
    return next();
  }

  // Replace the strict API-wide CSP: site pages need inline styles/JSON-LD
  // and the default template's fonts.
  setPublicSiteSecurityHeaders(res);

  // Self-hosted theme fonts. Served before any site-state checks because the
  // blocked/disabled placeholder pages reference them too.
  const fontMatch = req.path.match(/^\/site-fonts\/([a-z0-9-]+\.woff2)$/);
  if (fontMatch) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('font/woff2');
    return res.sendFile(fontMatch[1], { root: SITE_FONTS_DIR }, (error?: Error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  }

  try {
    const host = getRequestHost(req as any);

    if (isBlockedManagedHost(host)) {
      if (req.path === '/') return sendNoindexPlaceholder(res);
      if (req.path === '/robots.txt' || req.path === '/sitemap.xml') return res.status(404).end();
      return res.status(404).end();
    }

    const familyId = req.familyId;
    if (!familyId) return res.status(404).end();

    const settings = await circleSiteSettingsRepository.findByFamilyId(familyId);
    if (!settings?.enabled) {
      if (req.path === '/') return sendHtml(res, 200, buildDisabledSitePlaceholderHtml(getPublicSiteProductUrl()));
      if (req.path === '/robots.txt' || req.path === '/sitemap.xml') return res.status(404).end();
      return res.status(404).end();
    }

    const siteImageMatch = req.path.match(/^\/site-images\/([a-z0-9_-]+)(?:\/[^/]*)?$/);
    if (siteImageMatch) {
      const asset = await circleSitePublicationAssetRepository.findPublicSiteImage(familyId, siteImageMatch[1]);
      if (!asset || !isCircleSiteImageMimeType(asset.mime_type)) return res.status(404).end();
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(asset.mime_type);
      res.setHeader('Content-Length', String(Number(asset.size_bytes)));
      if (String(req.method || 'GET').toUpperCase() === 'HEAD') return res.end();
      const stream = publicSiteAssetStorageService.readAsset(asset.storage_key);
      stream.on('error', (error) => {
        routeLogger.error('Public site image read error:', error);
        if (!res.headersSent) res.status(404).end();
        else res.destroy();
      });
      return stream.pipe(res);
    }

    const mediaMatch = req.path.match(/^\/media\/([^/]+)(?:\/[^/]*)?$/);
    if (mediaMatch) {
      let assetId: string;
      try {
        assetId = decodeURIComponent(mediaMatch[1]);
      } catch {
        return res.status(404).end();
      }
      const asset = await circleSitePublicationAssetRepository.findPublicAsset(familyId, assetId);
      if (!asset) return res.status(404).end();
      if (asset.kind === 'image' && !isCircleSiteImageMimeType(asset.mime_type)) {
        return res.status(404).end();
      }
      const inlineVideo = asset.kind === 'download' && isCircleSiteVideoMimeType(asset.mime_type);

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=300');
      if (asset.kind === 'image') {
        res.type(asset.mime_type);
        res.setHeader('Content-Disposition', 'inline');
      } else if (inlineVideo) {
        res.type(asset.mime_type);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Accept-Ranges', 'bytes');
      } else {
        res.type('application/octet-stream');
        res.setHeader('Content-Disposition', contentDispositionFileName(asset.original_file_name));
      }
      const size = Number(asset.size_bytes);
      const range = inlineVideo ? parseVideoByteRange(req.headers.range, size) : null;
      if (range === false) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
      } else {
        res.setHeader('Content-Length', String(size));
      }
      if (String(req.method || 'GET').toUpperCase() === 'HEAD') return res.end();
      const stream = publicSiteAssetStorageService.readAsset(
        asset.storage_key,
        range ? { start: range.start, end: range.end } : undefined
      );
      stream.on('error', (error) => {
        routeLogger.error('Public site asset read error:', error);
        if (!res.headersSent) res.status(404).end();
        else res.destroy();
      });
      return stream.pipe(res);
    }

    const siteDir = publicSiteGeneratorService.siteDir(familyId);
    const requestedPath = req.path === '/' ? '/index.html' : req.path;
    const normalizedRelative = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');

    // Never serve dotfiles.
    if (normalizedRelative.split(/[/\\]/).some((segment) => segment.startsWith('.'))) {
      return res.status(404).end();
    }
    let resolvedPath = path.join(siteDir, normalizedRelative);

    // Path-traversal guard: resolved path must stay within the site directory.
    if (!resolvedPath.startsWith(path.join(siteDir, path.sep)) && resolvedPath !== siteDir) {
      return res.status(404).end();
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedPath);
    } catch {
      return res.status(404).end();
    }

    if (stat.isDirectory()) {
      resolvedPath = path.join(resolvedPath, 'index.html');
      try {
        stat = await fs.promises.stat(resolvedPath);
      } catch {
        return res.status(404).end();
      }
    }

    const ext = path.extname(resolvedPath);
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    res.type(contentType);
    fs.createReadStream(resolvedPath).pipe(res);
  } catch (error) {
    routeLogger.error('Public site serving error:', error);
    return res.status(500).end();
  }
});

export default router;
