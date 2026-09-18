import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { SITE_FONT_FACE_CSS } from './publicSiteFonts';
import {
  getCircleSiteVideoPosterTarget,
  isCircleSiteVideoMimeType,
  isCircleSiteVideoPosterAltText
} from '../../../shared/circleSiteAssets';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Public-site images are explicit uploaded assets. Markdown image syntax is
// rendered as a normal link so a publication cannot make visitors contact an
// arbitrary third-party image host.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const href = token.attrGet('src') || '';
  const label = token.content || href;
  return `<a href="${markdown.utils.escapeHtml(href)}">${markdown.utils.escapeHtml(label)}</a>`;
};

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 's', 'blockquote',
    'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
  },
};

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCirclusWordmark(productUrl: string): string {
  return `<a class="site-brand" href="${escapeHtml(productUrl)}" rel="noopener noreferrer" aria-label="Circlus">
    <svg viewBox="0 0 900 220" role="img" aria-hidden="true">
      <g class="wordmark-main" fill="none" stroke-width="35" stroke-linecap="round" stroke-linejoin="round">
        <g transform="translate(70,0)"><path d="M40 70A40 40 0 0 0-40 70M-40 70V150M-40 150A40 40 0 0 0 40 150"/></g>
        <g transform="translate(180,0)"><path d="M0 30V190"/></g>
        <g transform="translate(290,0)"><circle cx="0" cy="70" r="40"/><path d="M-40 70V190M0 110A40 40 0 0 1 40 150V190"/></g>
        <g transform="translate(440,0)"><path d="M40 70A40 40 0 0 0-40 70M-40 70V150M-40 150A40 40 0 0 0 40 150"/></g>
        <g transform="translate(585,0)"><path d="M-40 30V150A40 40 0 0 0 0 190H30"/></g>
      </g>
      <g class="wordmark-accent" transform="translate(700,0)" fill="none" stroke-width="35" stroke-linecap="round" stroke-linejoin="round"><path d="M-40 30V150M-40 150A40 40 0 0 0 40 150V30"/></g>
      <g class="wordmark-accent" transform="translate(830,0)" fill="none" stroke-width="35" stroke-linecap="round" stroke-linejoin="round"><path d="M40 30A40 40 0 0 0 0 70V150A40 40 0 0 1-40 190"/></g>
    </svg>
  </a>`;
}

function serializeJsonForHtml(value: Record<string, unknown>): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function formatPublicationTimeFallback(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function buildPublicationTimeScript(): string {
  return `
  (() => {
    try {
      const formatter = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      document.querySelectorAll('time.publication-time[datetime]').forEach((element) => {
        const date = new Date(element.getAttribute('datetime'));
        if (!Number.isNaN(date.getTime())) element.textContent = formatter.format(date);
      });
    } catch (_) {
      // The visible UTC fallback remains usable when Intl is unavailable.
    }
  })();
`;
}

/** Renders a publication body to sanitized HTML. Never derives content by decrypting messages — body always arrives as an explicit plaintext field. */
export function renderBodyToHtml(body: string, format: 'plain_text' | 'markdown'): string {
  if (format === 'plain_text') {
    return body
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }
  const rendered = markdown.render(body);
  return sanitizeHtml(rendered, SANITIZE_OPTIONS);
}

/** Avoids repeating an automatically derived title as the first line of the public body. */
export function renderPublicationBodyToHtml(
  body: string,
  title: string,
  format: 'plain_text' | 'markdown'
): string {
  const normalizedTitle = title.trim();
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (
    normalizedTitle
    && firstContentIndex >= 0
    && lines[firstContentIndex].trim() === normalizedTitle
  ) {
    lines.splice(firstContentIndex, 1);
    const remainder = lines.join('\n').trim();
    return remainder ? renderBodyToHtml(remainder, format) : '';
  }
  return renderBodyToHtml(body, format);
}

const SLUG_INVALID_CHARS = /[^a-z0-9]+/g;

export function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(SLUG_INVALID_CHARS, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'post';
}

export interface SitePost {
  slug: string;
  channelSlug: string;
  title: string;
  summary: string | null;
  bodyHtml: string;
  assets?: SitePostAsset[];
  publishedAt: Date;
}

export interface SitePostAsset {
  assetId: string;
  kind: 'image' | 'download';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  url: string;
}

export interface SiteChannel {
  slug: string;
  title: string;
  introText: string | null;
  introImageUrl: string | null;
  ctaLabel: string | null;
  guestLinkUrl: string | null;
  posts: SitePost[];
}

export interface SiteRenderContext {
  siteTitle: string;
  siteDescription: string | null;
  coverImageUrl: string | null;
  canonicalBaseUrl: string;
  productUrl: string;
  indexingEnabled: boolean;
  channels: SiteChannel[];
  allPosts: SitePost[];
}

function robotsMeta(indexingEnabled: boolean): string {
  return indexingEnabled ? '' : '<meta name="robots" content="noindex">\n  ';
}


/**
 * The public site is a self-contained static export, so its default theme is
 * embedded into every HTML document instead of depending on a generated asset.
 * The palette and typography intentionally follow the Circlus landing page.
 */
const DEFAULT_SITE_CSS = `
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      color-scheme: light;
      --bg: #faf7f4;
      --bg-2: #f3ede8;
      --surface: #ffffff;
      --border: #e4d9d3;
      --primary: #d45b43;
      --primary-dark: #b84a33;
      --primary-light: #f5cfc9;
      --primary-soft: #fdf0ee;
      --text: #2d2623;
      --muted: #8b7b75;
      --font-heading: 'Playfair Display', Georgia, serif;
      --font-body: 'Nunito', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --radius: 20px;
      --radius-large: 32px;
      --shadow: 0 18px 60px rgba(74, 49, 40, .08);
    }
    html { min-height: 100%; background: var(--bg); }
    body {
      min-height: 100vh;
      margin: 0;
      overflow-x: hidden;
      background:
        radial-gradient(circle at 100% 0, rgba(212, 91, 67, .12), transparent 34rem),
        radial-gradient(circle at 0 72%, rgba(212, 91, 67, .07), transparent 30rem),
        var(--bg);
      color: var(--text);
      font-family: var(--font-body);
      font-size: 16px;
      line-height: 1.7;
    }
    a { color: var(--primary); text-decoration-thickness: 1px; text-underline-offset: .18em; }
    a:hover { color: var(--primary-dark); }
    a:focus-visible { outline: 3px solid var(--primary-light); outline-offset: 3px; border-radius: 4px; }
    img { display: block; max-width: 100%; height: auto; }
    .site-shell { width: min(100% - 32px, 960px); margin: 0 auto; padding: 36px 0 56px; }
    .site-brand {
      display: block;
      width: 124px;
      margin-bottom: 28px;
      text-decoration: none;
    }
    .site-brand svg { display: block; width: 100%; height: auto; }
    .site-brand .wordmark-main { stroke: var(--text); }
    .site-brand .wordmark-accent { stroke: var(--primary); }
    .site-hero,
    .site-card,
    .site-article,
    .placeholder-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-large);
      background: rgba(255, 255, 255, .94);
      box-shadow: var(--shadow);
    }
    .site-hero { padding: clamp(28px, 7vw, 64px); }
    .eyebrow {
      margin: 0 0 12px;
      color: var(--primary);
      font-size: .75rem;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 0;
      color: var(--text);
      font-family: var(--font-heading);
      line-height: 1.18;
      text-wrap: balance;
    }
    h1 { max-width: 18ch; font-size: clamp(2.25rem, 8vw, 4.75rem); letter-spacing: -.035em; }
    h2 { font-size: clamp(1.6rem, 4vw, 2.25rem); }
    h3 { font-size: 1.35rem; }
    .site-description { max-width: 64ch; margin: 20px 0 0; color: var(--muted); font-size: 1.08rem; }
    .site-cover { width: 100%; aspect-ratio: 2 / 1; margin-top: 30px; border-radius: var(--radius); object-fit: cover; }
    .site-actions { margin: 24px 0 0; }
    .cta {
      display: inline-flex;
      min-height: 48px;
      align-items: center;
      justify-content: center;
      padding: 12px 24px;
      border-radius: 999px;
      background: var(--primary);
      box-shadow: 0 8px 24px rgba(212, 91, 67, .2);
      color: #fff;
      font-weight: 700;
      text-decoration: none;
      transition: background .2s, box-shadow .2s, transform .2s;
    }
    .cta:hover { background: var(--primary-dark); box-shadow: 0 12px 30px rgba(212, 91, 67, .28); color: #fff; transform: translateY(-1px); }
    .site-card { padding: clamp(24px, 4vw, 36px); box-shadow: none; }
    .site-section { margin-top: 20px; }
    .site-card > h2 { margin-bottom: 18px; }
    .link-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .link-list a {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 54px;
      padding: 13px 16px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--bg);
      color: var(--text);
      font-weight: 600;
      text-decoration: none;
      transition: border-color .2s, background .2s, color .2s, transform .2s;
    }
    .link-list a::after { content: '\\2192'; flex: 0 0 auto; color: var(--primary); }
    .link-list a:hover { border-color: var(--primary-light); background: var(--primary-soft); color: var(--primary-dark); transform: translateX(2px); }
    .empty-state { margin: 0; color: var(--muted); }
    .site-feed { display: grid; gap: 16px; }
    .site-feed > h2 { margin: 8px 4px 0; }
    .feed-list { display: grid; gap: 16px; }
    .feed-card {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--radius-large);
      background: rgba(255, 255, 255, .94);
      box-shadow: 0 10px 36px rgba(74, 49, 40, .06);
    }
    .feed-card-inner { padding: clamp(24px, 5vw, 42px); }
    .feed-card-channel { margin: 0 0 7px; color: var(--muted); font-size: .82rem; }
    .feed-card-channel a { color: inherit; }
    .feed-card-title a { color: var(--text); text-decoration: none; }
    .feed-card-title a:hover { color: var(--primary-dark); }
    .feed-card .publication-time { margin: 0 0 0 auto; text-align: right; white-space: nowrap; }
    .feed-card-content {
      position: relative;
      margin-top: 22px;
    }
    .feed-card-content > :first-child { margin-top: 0; }
    .feed-card-content > :last-child { margin-bottom: 0; }
    .feed-card-content p, .feed-card-content ul, .feed-card-content ol, .feed-card-content blockquote { margin: 0 0 1em; }
    .feed-card-content ul, .feed-card-content ol { padding-left: 1.4em; }
    .feed-card-content h1, .feed-card-content h2, .feed-card-content h3,
    .feed-card-content h4, .feed-card-content h5, .feed-card-content h6 { margin: 1.2em 0 .55em; font-size: 1.25rem; }
    .feed-card-content pre { overflow-x: auto; }
    .feed-card-media { position: relative; display: flex; width: 100%; justify-content: center; background: var(--bg-2); text-decoration: none; }
    .feed-card-media-count {
      position: absolute;
      right: 14px;
      top: 14px;
      padding: 5px 9px;
      border-radius: 999px;
      background: rgba(30, 24, 22, .72);
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
    }
    .feed-card-image { width: auto; max-width: 100%; max-height: min(75vh, 720px); object-fit: contain; }
    .feed-card-play {
      position: absolute;
      left: 50%;
      top: 50%;
      display: grid;
      width: 62px;
      height: 62px;
      place-items: center;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background: rgba(30, 24, 22, .72);
      color: #fff;
      font-size: 27px;
      line-height: 1;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .2);
    }
    .feed-card-video-placeholder { display: grid; width: 100%; min-height: 260px; place-items: center; background: #221d1b; color: #fff; }
    .feed-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .feed-card-footer-wrap { padding-top: 0; }
    .feed-card-link { font-weight: 700; }
    .breadcrumbs { margin: 0 0 18px; color: var(--muted); font-size: .9rem; }
    .breadcrumbs a { color: inherit; }
    .publication-time { display: block; margin-top: 18px; color: var(--muted); font-size: .88rem; }
    .site-article { margin-top: 20px; padding: clamp(24px, 6vw, 56px); }
    .site-article > :first-child { margin-top: 0; }
    .site-article > :last-child { margin-bottom: 0; }
    .site-article p, .site-article ul, .site-article ol, .site-article blockquote, .site-article pre, .site-article figure { margin: 0 0 1.25em; }
    .site-article h2, .site-article h3, .site-article h4 { margin: 1.6em 0 .65em; }
    .site-article ul, .site-article ol { padding-left: 1.4em; }
    .site-article blockquote { padding: 4px 0 4px 20px; border-left: 4px solid var(--primary-light); color: var(--muted); }
    .site-article code { border-radius: 6px; background: var(--bg-2); padding: .12em .35em; font-size: .9em; }
    .site-article pre { overflow-x: auto; border-radius: 14px; background: var(--text); padding: 18px; color: var(--bg); }
    .site-article pre code { background: transparent; padding: 0; }
    .site-article figure { margin-right: 0; margin-left: 0; }
    .site-article figure img { width: 100%; border-radius: var(--radius); }
    .site-article figure video { display: block; width: 100%; max-height: min(82vh, 900px); border-radius: var(--radius); background: #171312; }
    .publication-gallery { margin: 0 0 1.25em; }
    .publication-gallery-track {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      overscroll-behavior-inline: contain;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
      border-radius: var(--radius);
    }
    .publication-gallery-track::-webkit-scrollbar { display: none; }
    .site-article .publication-gallery-slide {
      flex: 0 0 100%;
      margin: 0;
      scroll-snap-align: center;
      scroll-snap-stop: always;
    }
    .publication-gallery-dots { display: flex; justify-content: center; gap: 7px; padding-top: 10px; }
    .publication-gallery-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--border);
      text-decoration: none;
    }
    .publication-gallery-dot:hover, .publication-gallery-dot:focus-visible { background: var(--primary); }
    .circlus-context { margin-top: 24px; padding: 24px 4px 0; border-top: 1px solid var(--border); color: var(--muted); font-size: .82rem; }
    .circlus-context p { max-width: 76ch; margin: 0 0 8px; }
    .placeholder-page { display: grid; place-items: center; }
    .placeholder-page .site-shell { padding-top: 48px; padding-bottom: 48px; }
    .placeholder-card { position: relative; overflow: hidden; padding: clamp(32px, 8vw, 72px); }
    .placeholder-card::after {
      position: absolute;
      right: -90px;
      bottom: -120px;
      width: 300px;
      height: 300px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(212, 91, 67, .14), transparent 70%);
      content: '';
      pointer-events: none;
    }
    .placeholder-card h1 { font-size: clamp(2.3rem, 9vw, 4.6rem); }
    .placeholder-card .site-description { max-width: 46ch; }
    .placeholder-card .site-actions { position: relative; z-index: 1; margin-top: 30px; }
    @media (min-width: 760px) {
      .site-shell { padding-top: 52px; padding-bottom: 72px; }
    }
    @media (max-width: 520px) {
      body { font-size: 15px; }
      .site-shell { width: min(100% - 20px, 960px); padding-top: 20px; }
      .site-brand { margin-bottom: 18px; }
      .site-hero, .site-card, .site-article, .placeholder-card { border-radius: var(--radius); }
      .site-card { padding: 22px; }
      .cta { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
`;

function defaultThemeHead(): string {
  return `  <style>${SITE_FONT_FACE_CSS}${DEFAULT_SITE_CSS}\n  </style>`;
}

function circlusContextBlock(ctx: SiteRenderContext): string {
  return `
  <footer class="circlus-context">
    <p>Published with <a href="${escapeHtml(ctx.productUrl)}" rel="noopener noreferrer">Circlus</a>.</p>
  </footer>`;
}

type SiteVisualMedia = {
  type: 'image' | 'video';
  asset: SitePostAsset;
  poster: SitePostAsset | null;
};

function getPostVisualMedia(post: SitePost): SiteVisualMedia[] {
  const assets = post.assets || [];
  const postersByTarget = new Map<string, SitePostAsset[]>();
  for (const asset of assets) {
    const target = getCircleSiteVideoPosterTarget(asset.altText);
    if (asset.kind !== 'image' || !target) continue;
    postersByTarget.set(target, [...(postersByTarget.get(target) || []), asset]);
  }
  return assets.flatMap((asset): SiteVisualMedia[] => {
    if (asset.kind === 'image') {
      return isCircleSiteVideoPosterAltText(asset.altText)
        ? []
        : [{ type: 'image', asset, poster: null }];
    }
    if (!isCircleSiteVideoMimeType(asset.mimeType)) return [];
    const matchingPosters = postersByTarget.get(asset.fileName) || [];
    const poster = matchingPosters.shift() || null;
    postersByTarget.set(asset.fileName, matchingPosters);
    return [{ type: 'video', asset, poster }];
  });
}

function imageDimensions(asset: SitePostAsset): string {
  return `${asset.width ? ` width="${asset.width}"` : ''}${asset.height ? ` height="${asset.height}"` : ''}`;
}

function renderFeedMedia(post: SitePost, postUrl: string): string {
  const media = getPostVisualMedia(post);
  const first = media[0];
  if (!first) return '';
  const count = media.length > 1
    ? `<span class="feed-card-media-count">${media.length}</span>`
    : '';
  if (first.type === 'image') {
    return `<a class="feed-card-media" href="${postUrl}" aria-label="${escapeHtml(post.title)}"><img class="feed-card-image" src="${escapeHtml(first.asset.url)}" alt="${escapeHtml(first.asset.altText || '')}"${imageDimensions(first.asset)} loading="lazy">${count}</a>`;
  }
  const cover = first.poster
    ? `<img class="feed-card-image" src="${escapeHtml(first.poster.url)}" alt=""${imageDimensions(first.poster)} loading="lazy">`
    : '<span class="feed-card-video-placeholder">Video</span>';
  return `<a class="feed-card-media" href="${postUrl}" aria-label="${escapeHtml(post.title)}">${cover}<span class="feed-card-play" aria-hidden="true">▶</span>${count}</a>`;
}

function buildFeedCardHtml(post: SitePost, channel?: SiteChannel): string {
  const postUrl = `/channels/${encodeURIComponent(post.channelSlug)}/posts/${encodeURIComponent(post.slug)}/`;
  const channelUrl = `/channels/${encodeURIComponent(post.channelSlug)}/`;
  const content = post.summary?.trim() && post.summary.trim() !== post.title.trim()
    ? `<p>${escapeHtml(post.summary)}</p>`
    : post.bodyHtml;

  return `    <article class="feed-card">
      <div class="feed-card-inner">
        ${channel ? `<p class="feed-card-channel"><a href="${channelUrl}">${escapeHtml(channel.title)}</a></p>` : ''}
        <h3 class="feed-card-title"><a href="${postUrl}">${escapeHtml(post.title)}</a></h3>
        ${content ? `<div class="feed-card-content">${content}</div>` : ''}
      </div>
      ${renderFeedMedia(post, postUrl)}
      <div class="feed-card-inner feed-card-footer-wrap"><div class="feed-card-footer"><a class="feed-card-link" href="${postUrl}">Open publication &rarr;</a><time class="publication-time" datetime="${post.publishedAt.toISOString()}">${formatPublicationTimeFallback(post.publishedAt)}</time></div></div>
    </article>`;
}

function htmlDocument(params: {
  title: string;
  description: string | null;
  canonicalUrl: string;
  indexingEnabled: boolean;
  ogImage?: string | null;
  jsonLd?: Record<string, unknown>;
  bodyClass: string;
  bodyHtml: string;
  bodyScript?: string;
}): string {
  const description = params.description ? escapeHtml(params.description) : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  ${description ? `<meta name="description" content="${description}">\n  ` : ''}${robotsMeta(params.indexingEnabled)}<link rel="canonical" href="${escapeHtml(params.canonicalUrl)}">
  <meta property="og:title" content="${escapeHtml(params.title)}">
  ${description ? `<meta property="og:description" content="${description}">\n  ` : ''}<meta property="og:url" content="${escapeHtml(params.canonicalUrl)}">
  ${params.ogImage ? `<meta property="og:image" content="${escapeHtml(params.ogImage)}">\n  ` : ''}${params.jsonLd ? `<script type="application/ld+json">${serializeJsonForHtml(params.jsonLd)}</script>\n  ` : ''}
${defaultThemeHead()}
</head>
<body class="${params.bodyClass}">
${params.bodyHtml}
${params.bodyScript || ''}
</body>
</html>
`;
}

export function buildHomepageHtml(ctx: SiteRenderContext): string {
  const channelLinks = ctx.channels
    .map((channel) => `    <li><a href="/channels/${encodeURIComponent(channel.slug)}/">${escapeHtml(channel.title)}</a></li>`)
    .join('\n');

  const recentPosts = ctx.allPosts
    .slice(0, 20)
    .map((post) => buildFeedCardHtml(
      post,
      ctx.channels.find((channel) => channel.slug === post.channelSlug)
    ))
    .join('\n');

  const visibleCta = ctx.channels.find((channel) => channel.guestLinkUrl && channel.ctaLabel);

  const body = `
  <div class="site-shell">
  ${renderCirclusWordmark(ctx.productUrl)}
  <header class="site-hero">
    <p class="eyebrow">Public Circle site</p>
    <h1>${escapeHtml(ctx.siteTitle)}</h1>
    ${ctx.siteDescription ? `<p class="site-description">${escapeHtml(ctx.siteDescription)}</p>` : ''}
    ${ctx.coverImageUrl ? `<img class="site-cover" src="${escapeHtml(ctx.coverImageUrl)}" alt="">` : ''}
    ${
      visibleCta
        ? `<p class="site-actions"><a class="cta" href="${escapeHtml(visibleCta.guestLinkUrl!)}" rel="noopener noreferrer">${escapeHtml(visibleCta.ctaLabel!)}</a></p>`
        : ''
    }
  </header>
  <nav class="site-card site-section" aria-label="Channels">
    <h2>Channels</h2>
    ${channelLinks ? `<ul class="link-list">\n${channelLinks}\n    </ul>` : '<p class="empty-state">No public channels yet.</p>'}
  </nav>
  <main class="site-feed site-section">
    <h2>Recent posts</h2>
    ${recentPosts ? `<div class="feed-list">\n${recentPosts}\n    </div>` : '<div class="site-card"><p class="empty-state">No public posts yet.</p></div>'}
  </main>
  ${circlusContextBlock(ctx)}
  </div>`;

  return htmlDocument({
    title: ctx.siteTitle,
    description: ctx.siteDescription,
    canonicalUrl: `${ctx.canonicalBaseUrl}/`,
    indexingEnabled: ctx.indexingEnabled,
    ogImage: ctx.coverImageUrl,
    bodyClass: 'site-page home-page',
    bodyHtml: body,
    bodyScript: '<script src="/publication-time.js" defer></script>',
  });
}

export function buildChannelHtml(ctx: SiteRenderContext, channel: SiteChannel): string {
  const postCards = channel.posts
    .map((post) => buildFeedCardHtml(post))
    .join('\n');

  const body = `
  <div class="site-shell">
  ${renderCirclusWordmark(ctx.productUrl)}
  <header class="site-hero">
    <p class="breadcrumbs"><a href="/">${escapeHtml(ctx.siteTitle)}</a></p>
    <p class="eyebrow">Channel</p>
    <h1>${escapeHtml(channel.title)}</h1>
    ${channel.introText ? `<p class="site-description">${escapeHtml(channel.introText)}</p>` : ''}
    ${channel.introImageUrl ? `<img class="site-cover" src="${escapeHtml(channel.introImageUrl)}" alt="">` : ''}
    ${
      channel.guestLinkUrl && channel.ctaLabel
        ? `<p class="site-actions"><a class="cta" href="${escapeHtml(channel.guestLinkUrl)}" rel="noopener noreferrer">${escapeHtml(channel.ctaLabel)}</a></p>`
        : ''
    }
  </header>
  <main class="site-feed site-section">
    <h2>Posts</h2>
    ${postCards ? `<div class="feed-list">\n${postCards}\n    </div>` : '<div class="site-card"><p class="empty-state">No public posts yet.</p></div>'}
  </main>
  ${circlusContextBlock(ctx)}
  </div>`;

  return htmlDocument({
    title: `${channel.title} — ${ctx.siteTitle}`,
    description: channel.introText,
    canonicalUrl: `${ctx.canonicalBaseUrl}/channels/${encodeURIComponent(channel.slug)}/`,
    indexingEnabled: ctx.indexingEnabled,
    ogImage: channel.introImageUrl,
    bodyClass: 'site-page channel-page',
    bodyHtml: body,
    bodyScript: '<script src="/publication-time.js" defer></script>',
  });
}

export function buildPostHtml(ctx: SiteRenderContext, channel: SiteChannel, post: SitePost): string {
  const contentHtml = buildPostContentHtml(post);
  const firstVisualMedia = getPostVisualMedia(post)[0];
  const socialImage = firstVisualMedia?.type === 'image'
    ? firstVisualMedia.asset
    : firstVisualMedia?.poster;
  const body = `
  <div class="site-shell">
  ${renderCirclusWordmark(ctx.productUrl)}
  <header class="site-hero">
    <p class="breadcrumbs"><a href="/">${escapeHtml(ctx.siteTitle)}</a> &rsaquo; <a href="/channels/${encodeURIComponent(channel.slug)}/">${escapeHtml(channel.title)}</a></p>
    <h1>${escapeHtml(post.title)}</h1>
    <time class="publication-time" datetime="${post.publishedAt.toISOString()}">${formatPublicationTimeFallback(post.publishedAt)}</time>
  </header>
  ${contentHtml.trim() ? `<article class="site-article">
${contentHtml}
  </article>` : ''}
  ${circlusContextBlock(ctx)}
  </div>`;

  return htmlDocument({
    title: `${post.title} — ${ctx.siteTitle}`,
    description: post.summary,
    canonicalUrl: `${ctx.canonicalBaseUrl}/channels/${encodeURIComponent(channel.slug)}/posts/${encodeURIComponent(post.slug)}/`,
    indexingEnabled: ctx.indexingEnabled,
    ogImage: socialImage ? `${ctx.canonicalBaseUrl}${socialImage.url}` : null,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.summary || undefined,
      datePublished: post.publishedAt.toISOString(),
    },
    bodyClass: 'site-page post-page',
    bodyHtml: body,
    bodyScript: '<script src="/publication-time.js" defer></script>',
  });
}

function buildPostContentHtml(post: SitePost): string {
  const visualMedia = getPostVisualMedia(post);
  const renderMedia = (media: SiteVisualMedia) => media.type === 'image'
    ? `<figure><img src="${escapeHtml(media.asset.url)}" alt="${escapeHtml(media.asset.altText || '')}"${imageDimensions(media.asset)} loading="lazy"></figure>`
    : `<figure><video controls preload="metadata" playsinline${media.poster ? ` poster="${escapeHtml(media.poster.url)}"` : ''}><source src="${escapeHtml(media.asset.url)}" type="${escapeHtml(media.asset.mimeType)}"><a href="${escapeHtml(media.asset.url)}" download>${escapeHtml(media.asset.fileName)}</a></video></figure>`;
  const mediaHtml = visualMedia.length > 1
    ? `<div class="publication-gallery" aria-label="Media gallery">
      <div class="publication-gallery-track">
        ${visualMedia.map((media, index) => `<div id="media-${index + 1}" class="publication-gallery-slide">${renderMedia(media)}</div>`).join('\n')}
      </div>
      <nav class="publication-gallery-dots" aria-label="Gallery navigation">
        ${visualMedia.map((media, index) => `<a class="publication-gallery-dot" href="#media-${index + 1}" aria-label="${escapeHtml(media.asset.fileName)}"></a>`).join('')}
      </nav>
    </div>`
    : visualMedia.map(renderMedia).join('\n');
  const downloadHtml = (post.assets || [])
    .filter((asset) => (
      asset.kind === 'download' && !isCircleSiteVideoMimeType(asset.mimeType)
    ))
    .map((asset) => `<p><a href="${escapeHtml(asset.url)}" download>${escapeHtml(asset.fileName)}</a></p>`)
    .join('\n');
  const assetHtml = [mediaHtml, downloadHtml].filter(Boolean).join('\n');
  return assetHtml ? `${post.bodyHtml}\n${assetHtml}` : post.bodyHtml;
}

export function buildSitemapXml(ctx: SiteRenderContext): string {
  const urls: string[] = [`${ctx.canonicalBaseUrl}/`];
  for (const channel of ctx.channels) {
    urls.push(`${ctx.canonicalBaseUrl}/channels/${encodeURIComponent(channel.slug)}/`);
    for (const post of channel.posts) {
      urls.push(`${ctx.canonicalBaseUrl}/channels/${encodeURIComponent(channel.slug)}/posts/${encodeURIComponent(post.slug)}/`);
    }
  }
  const entries = urls.map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

export function buildRobotsTxt(ctx: SiteRenderContext): string {
  if (!ctx.indexingEnabled) {
    return 'User-agent: *\nDisallow: /\n';
  }
  return `User-agent: *\nAllow: /\nSitemap: ${ctx.canonicalBaseUrl}/sitemap.xml\n`;
}

export function buildFeedJson(ctx: SiteRenderContext): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: ctx.siteTitle,
      home_page_url: `${ctx.canonicalBaseUrl}/`,
      feed_url: `${ctx.canonicalBaseUrl}/feed.json`,
      items: ctx.allPosts.slice(0, 50).map((post) => ({
        id: `${ctx.canonicalBaseUrl}/channels/${post.channelSlug}/posts/${post.slug}/`,
        url: `${ctx.canonicalBaseUrl}/channels/${post.channelSlug}/posts/${post.slug}/`,
        title: post.title,
        summary: post.summary || undefined,
        content_html: buildPostContentHtml(post),
        date_published: post.publishedAt.toISOString(),
      })),
    },
    null,
    2
  );
}

/** Blocked-managed-domain placeholder (§Managed Subdomain Control — ships with the publishing mechanism). */
export function buildBlockedDomainPlaceholderHtml(productUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Circlus Circle</title>
${defaultThemeHead()}
</head>
<body class="site-page placeholder-page">
  <div class="site-shell">
    <main class="placeholder-card">
      ${renderCirclusWordmark(productUrl)}
      <p class="eyebrow">Circlus Circle</p>
      <h1>This is a Circlus Circle domain.</h1>
      <p class="site-description">The public site for this Circle is not available yet.</p>
      <p class="site-actions"><a class="cta" href="${escapeHtml(productUrl)}" rel="noopener noreferrer">Visit Circlus</a></p>
    </main>
  </div>
</body>
</html>
`;
}

/** Disabled-site placeholder (site not enabled for this circle). */
export function buildDisabledSitePlaceholderHtml(productUrl: string): string {
  return buildBlockedDomainPlaceholderHtml(productUrl);
}
