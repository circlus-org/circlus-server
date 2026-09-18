import fs from 'fs';
import path from 'path';
import os from 'os';
import { Writable } from 'stream';

jest.mock('../db/repositories', () => ({
  circleSiteSettingsRepository: { findByFamilyId: jest.fn() },
  circleSitePublicationAssetRepository: {
    findPublicAsset: jest.fn(),
    findPublicSiteImage: jest.fn(),
  },
}));

import {
  circleSitePublicationAssetRepository,
  circleSiteSettingsRepository,
} from '../db/repositories';
import { publicSiteGeneratorService } from '../services/publicSiteGeneratorService';

const publicSiteRouter = require('./publicSite').default;

function getHandler() {
  return publicSiteRouter.stack[0].handle as (req: any, res: any, next: any) => Promise<void>;
}

function makeRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.status = jest.fn(function (this: any, code: number) {
    this.statusCode = code;
    return this;
  });
  res.type = jest.fn().mockReturnThis();
  res.setHeader = jest.fn();
  res.send = jest.fn();
  res.end = jest.fn(res.end.bind(res));
  res.getBody = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

describe('publicSite serving route', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'public-site-route-test-'));
    process.env.PUBLIC_SITE_STORAGE_DIR = tmpRoot;
    process.env.PUBLIC_SITE_ASSETS_DIR = path.join(tmpRoot, 'assets');
  });

  afterEach(async () => {
    delete process.env.PUBLIC_SITE_STORAGE_DIR;
    delete process.env.PUBLIC_SITE_ASSETS_DIR;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  test('never intercepts /api/*, /ws, /health', async () => {
    const next = jest.fn();
    const res = makeRes();
    await getHandler()({ path: '/api/config/capabilities', headers: { host: 'family.example.com' } }, res, next);
    await getHandler()({ path: '/ws', headers: { host: 'family.example.com' } }, res, next);
    await getHandler()({ path: '/health', headers: { host: 'family.example.com' } }, res, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('serves the noindex placeholder for a blocked managed subdomain, never generated files', async () => {
    const res = makeRes();
    await getHandler()({ path: '/', headers: { host: 'family.space.circlus.org' }, familyId: 'family-1' }, res, jest.fn());

    expect(circleSiteSettingsRepository.findByFamilyId).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('noindex'));
  });

  test('returns 404 for robots.txt and sitemap.xml on a blocked managed subdomain', async () => {
    const res1 = makeRes();
    await getHandler()({ path: '/robots.txt', headers: { host: 'family.space.circlus.org' }, familyId: 'family-1' }, res1, jest.fn());
    expect(res1.status).toHaveBeenCalledWith(404);

    const res2 = makeRes();
    await getHandler()({ path: '/sitemap.xml', headers: { host: 'family.space.circlus.org' }, familyId: 'family-1' }, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  test('shows the disabled placeholder when the site is not enabled', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: false });
    const res = makeRes();

    await getHandler()({ path: '/', headers: { host: 'family.example.com' }, familyId: 'family-1' }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('noindex'));
  });

  test('404s robots.txt/sitemap.xml when the site is not enabled', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: false });
    const res = makeRes();

    await getHandler()({ path: '/robots.txt', headers: { host: 'family.example.com' }, familyId: 'family-1' }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('serves a generated file when the site is enabled', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    const siteDir = publicSiteGeneratorService.siteDir('family-1');
    await fs.promises.mkdir(siteDir, { recursive: true });
    await fs.promises.writeFile(path.join(siteDir, 'index.html'), '<html>hi</html>');

    const res = makeRes();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await getHandler()({ path: '/', headers: { host: 'family.example.com' }, familyId: 'family-1' }, res, jest.fn());
    await finished;

    expect(res.type).toHaveBeenCalledWith('text/html; charset=utf-8');
    expect(res.getBody()).toBe('<html>hi</html>');
  });

  test('serves the publication-time helper as executable JavaScript', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    const siteDir = publicSiteGeneratorService.siteDir('family-1');
    await fs.promises.mkdir(siteDir, { recursive: true });
    await fs.promises.writeFile(path.join(siteDir, 'publication-time.js'), 'document.body.dataset.ready = "true";');

    const res = makeRes();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await getHandler()(
      { path: '/publication-time.js', headers: { host: 'family.example.com' }, familyId: 'family-1' },
      res,
      jest.fn()
    );
    await finished;

    expect(res.type).toHaveBeenCalledWith('application/javascript; charset=utf-8');
  });

  test('returns 404 for a missing file when the site is enabled', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    const siteDir = publicSiteGeneratorService.siteDir('family-1');
    await fs.promises.mkdir(siteDir, { recursive: true });

    const res = makeRes();
    await getHandler()({ path: '/channels/none/posts/none/', headers: { host: 'family.example.com' }, familyId: 'family-1' }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('serves repository-approved public files only as downloads', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    (circleSitePublicationAssetRepository.findPublicAsset as jest.Mock).mockResolvedValue({
      asset_id: 'pubasset_1',
      family_id: 'family-1',
      kind: 'download',
      original_file_name: 'report.pdf',
      mime_type: 'application/pdf',
      size_bytes: 7,
      storage_key: 'family-1/pubasset_1.bin',
    });
    const assetPath = path.join(tmpRoot, 'assets', 'family-1', 'pubasset_1.bin');
    await fs.promises.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.promises.writeFile(assetPath, 'payload');

    const res = makeRes();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await getHandler()(
      { path: '/media/pubasset_1/report.pdf', headers: { host: 'family.example.com' }, familyId: 'family-1' },
      res,
      jest.fn()
    );
    await finished;

    expect(circleSitePublicationAssetRepository.findPublicAsset).toHaveBeenCalledWith(
      'family-1',
      'pubasset_1'
    );
    expect(res.type).toHaveBeenCalledWith('application/octet-stream');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('attachment;')
    );
    expect(res.getBody()).toBe('payload');
  });

  test('serves only repository-approved self-hosted site images', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    (circleSitePublicationAssetRepository.findPublicSiteImage as jest.Mock).mockResolvedValue({
      asset_id: 'siteimg_1',
      family_id: 'family-1',
      kind: 'image',
      original_file_name: 'cover.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 7,
      storage_key: 'family-1/siteimg_1.bin',
    });
    const assetPath = path.join(tmpRoot, 'assets', 'family-1', 'siteimg_1.bin');
    await fs.promises.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.promises.writeFile(assetPath, 'payload');

    const res = makeRes();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await getHandler()(
      { path: '/site-images/siteimg_1/cover.jpg', method: 'GET', headers: { host: 'family.example.com' }, familyId: 'family-1' },
      res,
      jest.fn()
    );
    await finished;

    expect(circleSitePublicationAssetRepository.findPublicSiteImage).toHaveBeenCalledWith(
      'family-1',
      'siteimg_1'
    );
    expect(res.type).toHaveBeenCalledWith('image/jpeg');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=31536000, immutable');
    expect(res.getBody()).toBe('payload');
  });

  test('serves allowlisted public videos inline with byte ranges', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    (circleSitePublicationAssetRepository.findPublicAsset as jest.Mock).mockResolvedValue({
      asset_id: 'pubasset_video',
      family_id: 'family-1',
      kind: 'download',
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 10,
      storage_key: 'family-1/pubasset_video.bin',
    });
    const assetPath = path.join(tmpRoot, 'assets', 'family-1', 'pubasset_video.bin');
    await fs.promises.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.promises.writeFile(assetPath, '0123456789');

    const res = makeRes();
    const finished = new Promise((resolve) => res.on('finish', resolve));
    await getHandler()(
      {
        path: '/media/pubasset_video/clip.mp4',
        method: 'GET',
        headers: { host: 'family.example.com', range: 'bytes=2-5' },
        familyId: 'family-1'
      },
      res,
      jest.fn()
    );
    await finished;

    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.type).toHaveBeenCalledWith('video/mp4');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'inline');
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 2-5/10');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '4');
    expect(res.getBody()).toBe('2345');
  });

  test('serves theme fonts with immutable caching, even on blocked managed hosts', async () => {
    const res = makeRes();
    res.sendFile = jest.fn();
    await getHandler()(
      { path: '/site-fonts/nunito-400-latin.woff2', headers: { host: 'family.space.circlus.org' }, familyId: 'family-1' },
      res,
      jest.fn()
    );

    expect(res.type).toHaveBeenCalledWith('font/woff2');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=31536000, immutable');
    expect(res.sendFile).toHaveBeenCalledWith(
      'nunito-400-latin.woff2',
      { root: path.resolve(process.cwd(), 'assets', 'site-fonts') },
      expect.any(Function)
    );
    expect(circleSiteSettingsRepository.findByFamilyId).not.toHaveBeenCalled();
  });

  test('ships one variable font file per family and language subset with its license', () => {
    const fontsDir = path.resolve(process.cwd(), 'assets', 'site-fonts');
    const files = fs.readdirSync(fontsDir).sort();
    expect(files.filter((file) => file.endsWith('.woff2'))).toEqual([
      'nunito-400-cyrillic-ext.woff2',
      'nunito-400-cyrillic.woff2',
      'nunito-400-latin-ext.woff2',
      'nunito-400-latin.woff2',
      'nunito-400-vietnamese.woff2',
      'playfair-display-500-cyrillic.woff2',
      'playfair-display-500-latin-ext.woff2',
      'playfair-display-500-latin.woff2',
      'playfair-display-500-vietnamese.woff2',
    ]);
    const license = fs.readFileSync(path.join(fontsDir, 'OFL.txt'), 'utf8');
    expect(license).toContain('The Nunito Project Authors');
    expect(license).toContain('The Playfair Display Project Authors');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  test('rejects font names outside the expected pattern', async () => {
    const res = makeRes();
    res.sendFile = jest.fn();
    await getHandler()(
      { path: '/site-fonts/..%2Fsecret.woff2', headers: { host: 'family.space.circlus.org' }, familyId: 'family-1' },
      res,
      jest.fn()
    );

    expect(res.sendFile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('never serves dotfiles', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    const siteDir = publicSiteGeneratorService.siteDir('family-1');
    await fs.promises.mkdir(siteDir, { recursive: true });
    await fs.promises.writeFile(path.join(siteDir, '.internal'), 'do-not-serve');

    const res = makeRes();
    await getHandler()(
      { path: '/.internal', headers: { host: 'family.example.com' }, familyId: 'family-1' },
      res,
      jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects path traversal attempts', async () => {
    (circleSiteSettingsRepository.findByFamilyId as jest.Mock).mockResolvedValue({ enabled: true });
    const siteDir = publicSiteGeneratorService.siteDir('family-1');
    await fs.promises.mkdir(siteDir, { recursive: true });
    // A secret file outside the family's site dir, in the shared root.
    await fs.promises.writeFile(path.join(tmpRoot, 'secret.txt'), 'do-not-serve');

    const res = makeRes();
    await getHandler()(
      { path: '/../secret.txt', headers: { host: 'family.example.com' }, familyId: 'family-1' },
      res,
      jest.fn()
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
