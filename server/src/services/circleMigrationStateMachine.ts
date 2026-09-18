export const MIGRATION_SLOT_STATUSES = [
  'pending',
  'verified',
  'reserved',
  'importing',
  'imported',
  'waiting_cutover',
  'activating',
  'active',
  'failed',
  'revoked',
  'expired',
  'aborted'
] as const;

export type MigrationSlotStatus = typeof MIGRATION_SLOT_STATUSES[number];

export const SOURCE_MIGRATION_STATUSES = [
  'draft',
  'preflight',
  'ready',
  'scheduled',
  'freezing',
  'frozen',
  'exporting',
  'transferring',
  'waiting_import',
  'waiting_cutover',
  'cutover',
  'migrated',
  'failed',
  'rollback_required',
  'aborted'
] as const;

export type SourceMigrationStatus = typeof SOURCE_MIGRATION_STATUSES[number];

const slotTransitions: Record<MigrationSlotStatus, readonly MigrationSlotStatus[]> = {
  pending: ['verified', 'revoked', 'expired'],
  verified: ['reserved', 'revoked', 'expired', 'aborted'],
  reserved: ['importing', 'failed', 'aborted'],
  importing: ['imported', 'failed', 'aborted'],
  imported: ['waiting_cutover', 'failed', 'aborted'],
  waiting_cutover: ['activating', 'failed', 'aborted'],
  activating: ['active', 'failed'],
  active: [],
  failed: ['importing', 'activating', 'aborted'],
  revoked: [],
  expired: [],
  aborted: []
};

const sourceTransitions: Record<SourceMigrationStatus, readonly SourceMigrationStatus[]> = {
  draft: ['preflight', 'aborted'],
  preflight: ['ready', 'failed', 'aborted'],
  ready: ['scheduled', 'freezing', 'failed', 'aborted'],
  scheduled: ['freezing', 'failed', 'aborted'],
  freezing: ['frozen', 'failed', 'aborted'],
  frozen: ['exporting', 'failed', 'aborted'],
  exporting: ['transferring', 'failed', 'aborted'],
  transferring: ['waiting_import', 'failed', 'aborted'],
  waiting_import: ['waiting_cutover', 'failed', 'aborted'],
  waiting_cutover: ['cutover', 'failed', 'aborted'],
  cutover: ['migrated', 'rollback_required', 'failed'],
  migrated: [],
  failed: ['preflight', 'freezing', 'exporting', 'transferring', 'waiting_import', 'cutover', 'aborted'],
  rollback_required: ['migrated'],
  aborted: []
};

export function canTransitionMigrationSlot(from: MigrationSlotStatus, to: MigrationSlotStatus): boolean {
  return from === to || slotTransitions[from].includes(to);
}

export function canTransitionSourceMigration(from: SourceMigrationStatus, to: SourceMigrationStatus): boolean {
  return from === to || sourceTransitions[from].includes(to);
}

export function assertMigrationSlotTransition(from: MigrationSlotStatus, to: MigrationSlotStatus): void {
  if (!canTransitionMigrationSlot(from, to)) {
    throw new Error(`Invalid migration slot transition: ${from} -> ${to}`);
  }
}

export function assertSourceMigrationTransition(from: SourceMigrationStatus, to: SourceMigrationStatus): void {
  if (!canTransitionSourceMigration(from, to)) {
    throw new Error(`Invalid source migration transition: ${from} -> ${to}`);
  }
}

export function isTerminalMigrationSlotStatus(status: MigrationSlotStatus): boolean {
  return slotTransitions[status].length === 0;
}

export function isTerminalSourceMigrationStatus(status: SourceMigrationStatus): boolean {
  return sourceTransitions[status].length === 0;
}
