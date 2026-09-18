export type StoredCircleProfilePublication = {
  revision: number;
  sourceRevision: number | null;
  publicationId: string;
  publicationKind: 'manual' | 'republish';
} | null;

export type IncomingCircleProfilePublication = {
  revision: number;
  sourceRevision: number | null;
  publicationId: string;
  publicationKind: 'manual' | 'republish';
};

export type CircleProfilePublicationDecision = 'apply' | 'idempotent' | 'reject';

export function decideCircleProfilePublication(
  current: StoredCircleProfilePublication,
  incoming: IncomingCircleProfilePublication
): CircleProfilePublicationDecision {
  if (current?.publicationId === incoming.publicationId) return 'idempotent';
  const matchesCurrent = current
    ? incoming.sourceRevision === current.revision
    : incoming.sourceRevision === null;
  const manualSupersedesBackground = Boolean(
    current
    && incoming.publicationKind === 'manual'
    && current.publicationKind === 'republish'
    && incoming.sourceRevision === current.sourceRevision
  );
  if (!(matchesCurrent || manualSupersedesBackground)) return 'reject';
  if (current && incoming.revision <= current.revision) return 'reject';
  return 'apply';
}
