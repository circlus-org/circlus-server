import fs from 'node:fs';
import path from 'node:path';

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolute] : [];
  });
}

describe('server environment reference', () => {
  it('documents every statically referenced environment variable', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const referenced = new Set<string>();
    for (const file of listTypeScriptFiles(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
        referenced.add(match[1] || match[2]);
      }
    }
    const configRoot = path.resolve(sourceRoot, 'config');
    for (const file of listTypeScriptFiles(configRoot)) {
      if (!file.endsWith('RuntimeConfig.ts') && !file.endsWith('runtimeConfigParsing.ts')) continue;
      const typedConfigSource = fs.readFileSync(file, 'utf8');
      for (const match of typedConfigSource.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)) {
        referenced.add(match[1]);
      }
    }

    const environmentReference = fs.readFileSync(
      path.resolve(process.cwd(), '.env.example'),
      'utf8'
    );
    const documented = new Set(
      [...environmentReference.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1])
    );
    const missing = [...referenced].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
