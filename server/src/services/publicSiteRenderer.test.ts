import {
  renderBodyToHtml,
  renderPublicationBodyToHtml,
  slugify,
  buildBlockedDomainPlaceholderHtml,
  buildChannelHtml,
  buildHomepageHtml,
  buildPostHtml,
  buildRobotsTxt,
  buildSitemapXml,
  type SiteRenderContext,
} from './publicSiteRenderer';

describe('renderBodyToHtml', () => {
  test('escapes plain_text content', () => {
    const html = renderBodyToHtml('<script>alert(1)</script>', 'plain_text');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('does not render a script tag as live markup', () => {
    const html = renderBodyToHtml('Hello\n\n<script>alert(1)</script>', 'markdown');
    expect(html).not.toMatch(/<script\b/);
    expect(html).toContain('&lt;script&gt;');
  });

  test('does not render raw HTML as live markup (html:false escapes it to inert text)', () => {
    const html = renderBodyToHtml('<img src="x" onerror="alert(1)">', 'markdown');
    // The literal text may still appear (escaped), but there must be no actual <img> tag.
    expect(html).not.toMatch(/<img\b/);
    expect(html).toContain('&lt;img');
  });

  test('never emits a live javascript: href', () => {
    const html = renderBodyToHtml('[click me](javascript:alert(1))', 'markdown');
    expect(html).not.toMatch(/href\s*=\s*["']javascript:/i);
  });

  test('keeps safe markdown formatting', () => {
    const html = renderBodyToHtml('# Title\n\nSome **bold** text with a [link](https://example.com).', 'markdown');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  test('turns remote markdown images into links instead of loading them', () => {
    const html = renderBodyToHtml('![Remote photo](https://cdn.example/photo.jpg)', 'markdown');
    expect(html).toContain('<a href="https://cdn.example/photo.jpg"');
    expect(html).toContain('Remote photo</a>');
    expect(html).not.toContain('<img');
  });
});

describe('renderPublicationBodyToHtml', () => {
  test('does not repeat a one-line body that is already used as the title', () => {
    expect(renderPublicationBodyToHtml('Sunset in Batumi', 'Sunset in Batumi', 'plain_text')).toBe('');
  });

  test('removes a matching first line but preserves the rest of the post', () => {
    const html = renderPublicationBodyToHtml(
      'Sunset in Batumi\n\nThe sea was calm.',
      'Sunset in Batumi',
      'plain_text'
    );
    expect(html).toBe('<p>The sea was calm.</p>');
  });

  test('keeps the complete body when an explicit title is different', () => {
    const html = renderPublicationBodyToHtml('The actual post text', 'A separate title', 'plain_text');
    expect(html).toBe('<p>The actual post text</p>');
  });
});

describe('slugify', () => {
  test('lowercases and dashes', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  test('collapses non-alphanumeric runs', () => {
    expect(slugify('  Multiple   Spaces & Punctuation!! ')).toBe('multiple-spaces-punctuation');
  });

  test('falls back for empty input', () => {
    expect(slugify('')).toBe('post');
    expect(slugify('!!!')).toBe('post');
  });
});

function baseCtx(overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    siteTitle: 'Test Circle',
    siteDescription: null,
    coverImageUrl: null,
    canonicalBaseUrl: 'https://circle.example.com',
    productUrl: 'https://circlus.org',
    indexingEnabled: false,
    channels: [],
    allPosts: [],
    ...overrides,
  };
}

describe('buildRobotsTxt', () => {
  test('disallows all when indexing disabled', () => {
    expect(buildRobotsTxt(baseCtx({ indexingEnabled: false }))).toBe('User-agent: *\nDisallow: /\n');
  });

  test('allows and references sitemap when indexing enabled', () => {
    const robots = buildRobotsTxt(baseCtx({ indexingEnabled: true }));
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://circle.example.com/sitemap.xml');
  });
});

describe('buildSitemapXml', () => {
  test('includes homepage, channels, and posts', () => {
    const xml = buildSitemapXml(
      baseCtx({
        channels: [
          {
            slug: 'news',
            title: 'News',
            introText: null,
            introImageUrl: null,
            ctaLabel: null,
            guestLinkUrl: null,
            posts: [
              {
                slug: 'hello',
                channelSlug: 'news',
                title: 'Hello',
                summary: null,
                bodyHtml: '<p>hi</p>',
                publishedAt: new Date('2026-01-01T00:00:00Z'),
              },
            ],
          },
        ],
      })
    );
    expect(xml).toContain('<loc>https://circle.example.com/</loc>');
    expect(xml).toContain('<loc>https://circle.example.com/channels/news/</loc>');
    expect(xml).toContain('<loc>https://circle.example.com/channels/news/posts/hello/</loc>');
  });

  test('excludes unpublished posts (they are simply absent from allPosts/channels)', () => {
    const xml = buildSitemapXml(baseCtx());
    expect(xml).not.toContain('/posts/');
  });
});

describe('buildPostHtml', () => {
  test('includes the default Circlus theme and responsive page structure', () => {
    const html = buildPostHtml(baseCtx(), {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [],
    }, {
      slug: 'styled-post',
      channelSlug: 'news',
      title: 'Styled post',
      summary: null,
      bodyHtml: '<p>Body</p>',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('--primary: #d45b43');
    expect(html).toContain("font-family: 'Playfair Display'");
    expect(html).toContain('/site-fonts/playfair-display-500-latin.woff2');
    expect(html).toContain('font-weight: 500 700');
    expect(html).toContain('font-weight: 400 700');
    expect(html).not.toContain('/site-fonts/playfair-display-700-latin.woff2');
    expect(html).not.toContain('/site-fonts/nunito-700-latin.woff2');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(html).toContain('<body class="site-page post-page">');
    expect(html).toContain('<article class="site-article">');
    expect(html).toContain('class="site-brand"');
    expect(html).toContain('<svg viewBox="0 0 900 220"');
    expect(html).not.toContain('>CIRCL<span>US</span>');
    expect(html).not.toContain('>Publication</p>');
    expect(html).toContain('Published with <a');
    expect(html).not.toContain('not the private end-to-end encrypted guest chat');
  });

  test('shows publication time without seconds and localizes it in the visitor time zone', () => {
    const html = buildPostHtml(baseCtx(), {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [],
    }, {
      slug: 'dated-post',
      channelSlug: 'news',
      title: 'Dated post',
      summary: null,
      bodyHtml: '<p>Body</p>',
      publishedAt: new Date('2026-08-02T20:18:13.328Z'),
    });

    expect(html).toContain('datetime="2026-08-02T20:18:13.328Z">2026-08-02 20:18 UTC</time>');
    expect(html).toContain('<script src="/publication-time.js" defer></script>');
    expect(html).not.toContain('>2026-08-02T20:18:13.328Z</time>');
  });

  test('escapes JSON-LD values so a title cannot close the script element', () => {
    const channel = {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [],
    };
    const html = buildPostHtml(baseCtx(), channel, {
      slug: 'unsafe-title',
      channelSlug: 'news',
      title: '</script><script>alert(1)</script>',
      summary: null,
      bodyHtml: '<p>Safe body</p>',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  test('renders public images and downloadable files without trusting their metadata', () => {
    const channel = {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [],
    };
    const html = buildPostHtml(baseCtx(), channel, {
      slug: 'assets',
      channelSlug: 'news',
      title: 'Assets',
      summary: null,
      bodyHtml: '<p>Files</p>',
      assets: [
        {
          assetId: 'asset-1',
          kind: 'image',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
          width: 640,
          height: 480,
          altText: 'A <photo>',
          url: '/media/asset-1/photo.jpg',
        },
        {
          assetId: 'asset-2',
          kind: 'image',
          fileName: 'second.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 120,
          width: 800,
          height: 600,
          altText: 'Second photo',
          url: '/media/asset-2/second.jpg',
        },
        {
          assetId: 'asset-3',
          kind: 'download',
          fileName: '<report>.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 200,
          width: null,
          height: null,
          altText: null,
          url: '/media/asset-2/report.pdf',
        },
      ],
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(html).toContain('src="/media/asset-1/photo.jpg"');
    expect(html).toContain('width="640" height="480"');
    expect(html).toContain('alt="A &lt;photo&gt;"');
    expect(html).toContain('class="publication-gallery-track"');
    expect(html).toContain('src="/media/asset-2/second.jpg"');
    expect(html).toContain('href="#media-2"');
    expect(html).toContain('&lt;report&gt;.pdf');
    expect(html).not.toContain('<report>');
    expect(html).toContain('href="/media/asset-2/report.pdf" download');
    expect(html).toContain('property="og:image" content="https://circle.example.com/media/asset-1/photo.jpg"');
  });

  test('renders video with its hidden poster while keeping the feed cover static', () => {
    const assets = [
      {
        assetId: 'poster-1',
        kind: 'image' as const,
        fileName: 'clip-poster.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 80,
        width: 1280,
        height: 720,
        altText: 'circlus-video-poster:clip.mp4',
        url: '/media/poster-1/clip-poster.jpg',
      },
      {
        assetId: 'video-1',
        kind: 'download' as const,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1000,
        width: null,
        height: null,
        altText: null,
        url: '/media/video-1/clip.mp4',
      },
      {
        assetId: 'image-1',
        kind: 'image' as const,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        width: 640,
        height: 480,
        altText: 'Photo',
        url: '/media/image-1/photo.jpg',
      },
    ];
    const post = {
      slug: 'video-post',
      channelSlug: 'news',
      title: 'Video post',
      summary: null,
      bodyHtml: '<p>Body</p>',
      assets,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const channel = {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [post],
    };
    const ctx = baseCtx({ channels: [channel], allPosts: [post] });
    const detailHtml = buildPostHtml(ctx, channel, post);
    const feedHtml = buildHomepageHtml(ctx);

    expect(detailHtml).toContain('<video controls preload="metadata" playsinline poster="/media/poster-1/clip-poster.jpg">');
    expect(detailHtml).toContain('<source src="/media/video-1/clip.mp4" type="video/mp4">');
    expect(detailHtml).not.toContain('<img src="/media/poster-1/clip-poster.jpg"');
    expect(detailHtml).toContain('property="og:image" content="https://circle.example.com/media/poster-1/clip-poster.jpg"');
    expect(feedHtml).toContain('<img class="feed-card-image" src="/media/poster-1/clip-poster.jpg"');
    expect(feedHtml).toContain('class="feed-card-play"');
    expect(feedHtml).toContain('class="feed-card-media-count">2</span>');
    expect(feedHtml).not.toContain('<video');
  });
});

describe('default public site theme', () => {
  test('styles the homepage and empty states', () => {
    const html = buildHomepageHtml(baseCtx());

    expect(html).toContain('<body class="site-page home-page">');
    expect(html).toContain('<header class="site-hero">');
    expect(html).toContain('No public channels yet.');
    expect(html).toContain('No public posts yet.');
    expect(html).toContain('--bg: #faf7f4');
  });

  test('renders recent publications as a readable feed while preserving individual post pages', () => {
    const post = {
      slug: 'hello',
      channelSlug: 'news',
      title: 'Hello from the feed',
      summary: null,
      bodyHtml: '<p>Readable publication body.</p>',
      assets: [{
        assetId: 'image-1',
        kind: 'image' as const,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        width: 640,
        height: 480,
        altText: 'Feed photo',
        url: '/media/image-1/photo.jpg',
      }],
      publishedAt: new Date('2026-08-02T20:18:13.328Z'),
    };
    const channel = {
      slug: 'news',
      title: 'News',
      introText: null,
      introImageUrl: null,
      ctaLabel: null,
      guestLinkUrl: null,
      posts: [post],
    };
    const ctx = baseCtx({ channels: [channel], allPosts: [post] });

    for (const html of [buildHomepageHtml(ctx), buildChannelHtml(ctx, channel)]) {
      expect(html).toContain('<article class="feed-card">');
      expect(html).toContain('<p>Readable publication body.</p>');
      expect(html).toContain('src="/media/image-1/photo.jpg"');
      expect(html).toContain('class="feed-card-media"');
      expect(html).toContain('object-fit: contain');
      expect(html).toContain('href="/channels/news/posts/hello/"');
      expect(html).toContain('datetime="2026-08-02T20:18:13.328Z">2026-08-02 20:18 UTC</time>');
      expect(html).toContain('<script src="/publication-time.js" defer></script>');
      expect(html.indexOf('Open publication')).toBeLessThan(html.indexOf('datetime="2026-08-02T20:18:13.328Z"'));
    }
  });

  test('uses the same visual theme for the disabled-site placeholder', () => {
    const html = buildBlockedDomainPlaceholderHtml('https://circlus.org');

    expect(html).toContain('<body class="site-page placeholder-page">');
    expect(html).toContain('<main class="placeholder-card">');
    expect(html).toContain('--primary: #d45b43');
    expect(html).toContain('href="https://circlus.org"');
  });
});
