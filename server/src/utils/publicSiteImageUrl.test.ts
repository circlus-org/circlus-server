import { normalizeSelfHostedPublicSiteImageUrl } from './publicSiteImageUrl';

describe('normalizeSelfHostedPublicSiteImageUrl', () => {
  test('accepts only same-origin site-image paths', () => {
    expect(normalizeSelfHostedPublicSiteImageUrl('/site-images/siteimg_1/cover.jpg'))
      .toBe('/site-images/siteimg_1/cover.jpg');
    expect(normalizeSelfHostedPublicSiteImageUrl('https://cdn.example/cover.jpg')).toBeNull();
    expect(normalizeSelfHostedPublicSiteImageUrl('//cdn.example/cover.jpg')).toBeNull();
    expect(normalizeSelfHostedPublicSiteImageUrl('/media/pubasset_1/cover.jpg')).toBeNull();
  });
});
