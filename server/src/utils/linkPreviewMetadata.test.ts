import { parseLinkPreviewMetadata } from './linkPreviewMetadata';

describe('link preview HTML metadata', () => {
  test('handles attribute order, quotes, entities and metadata priority', () => {
    expect(parseLinkPreviewMetadata(`
      <title>Fallback &amp; title</title>
      <meta name="twitter:title" content="Twitter">
      <META content='Open &quot;Graph&quot;' PROPERTY="og:title">
      <meta content="A &#x1F600; &amp; B" name=description>
      <meta name=twitter:image:src content="https://example.com/a.png">
    `)).toEqual({ title: 'Open "Graph"', description: 'A 😀 & B', imageUrl: 'https://example.com/a.png' });
  });

  test('does not interpret meta markup in comments or script contents', () => {
    expect(parseLinkPreviewMetadata(`<!-- <meta property="og:title" content="fake"> -->
      <script>var text = '<meta property="og:title" content="fake">';</script>
      <title>Real title</title>`).title).toBe('Real title');
  });

  test('handles a maximum-sized unterminated attribute without regex backtracking', () => {
    expect(parseLinkPreviewMetadata('<meta property="og:title" content="' + 'a'.repeat(512 * 1024)))
      .toEqual({ title: null, description: null, imageUrl: null });
  });
});
