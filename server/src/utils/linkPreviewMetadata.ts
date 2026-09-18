import { Parser } from 'htmlparser2';

const META_KEYS = new Set([
  'property:og:title', 'property:og:description', 'property:og:image',
  'name:twitter:title', 'name:twitter:description', 'name:description',
  'name:twitter:image', 'name:twitter:image:src'
]);

/** Streaming tokenization avoids backtracking on untrusted, malformed HTML. */
export function parseLinkPreviewMetadata(html: string) {
  const metadata = new Map<string, string>();
  let inTitle = false;
  let titleText = '';
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === 'title' && !titleText) inTitle = true;
      if (name !== 'meta') return;
      const content = attributes.content?.trim().slice(0, 4096);
      if (!content) return;
      for (const attribute of ['property', 'name']) {
        const key = `${attribute}:${attributes[attribute]?.toLowerCase()}`;
        if (META_KEYS.has(key) && !metadata.has(key)) metadata.set(key, content);
      }
    },
    ontext(text) {
      if (inTitle) titleText += text.slice(0, Math.max(0, 300 - titleText.length));
    },
    onclosetag(name) {
      if (name === 'title') inTitle = false;
    }
  }, { decodeEntities: true });
  parser.end(html);
  return {
    title: metadata.get('property:og:title') || metadata.get('name:twitter:title') || titleText.trim() || null,
    description: metadata.get('property:og:description') || metadata.get('name:twitter:description') || metadata.get('name:description') || null,
    imageUrl: metadata.get('property:og:image') || metadata.get('name:twitter:image') || metadata.get('name:twitter:image:src') || null
  };
}
