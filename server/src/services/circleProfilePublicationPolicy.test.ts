import { decideCircleProfilePublication } from './circleProfilePublicationPolicy';
import { circleProfileAvatarBlobId } from './circleProfileAvatarPublication';

const current = {
  revision: 20,
  sourceRevision: 10,
  publicationId: 'publication-current',
  publicationKind: 'republish' as const,
};

describe('Circle profile publication compare-and-swap', () => {
  it('derives the client-compatible staged avatar blob id', () => {
    expect(circleProfileAvatarBlobId('identity-1', 'publication-123456'))
      .toBe('av_bpws9lOA1d90hyV1bL14xl9BrlZy');
  });
  it('accepts genesis and a direct revision advance', () => {
    expect(decideCircleProfilePublication(null, {
      revision: 10, sourceRevision: null, publicationId: 'publication-genesis', publicationKind: 'manual',
    })).toBe('apply');
    expect(decideCircleProfilePublication(current, {
      revision: 30, sourceRevision: 20, publicationId: 'publication-next', publicationKind: 'manual',
    })).toBe('apply');
  });

  it('makes retries of one logical operation idempotent', () => {
    expect(decideCircleProfilePublication(current, {
      revision: 999, sourceRevision: null, publicationId: current.publicationId, publicationKind: 'manual',
    })).toBe('idempotent');
  });

  it('rejects the losing concurrent background publication', () => {
    expect(decideCircleProfilePublication(current, {
      revision: 30, sourceRevision: 10, publicationId: 'publication-racer', publicationKind: 'republish',
    })).toBe('reject');
  });

  it('lets an explicit manual edit supersede a background publication based on the same source', () => {
    expect(decideCircleProfilePublication(current, {
      revision: 30, sourceRevision: 10, publicationId: 'publication-manual', publicationKind: 'manual',
    })).toBe('apply');
  });

  it('does not let a stale manual edit overwrite another manual edit', () => {
    expect(decideCircleProfilePublication({ ...current, publicationKind: 'manual' }, {
      revision: 30, sourceRevision: 10, publicationId: 'publication-stale-manual', publicationKind: 'manual',
    })).toBe('reject');
  });
});
