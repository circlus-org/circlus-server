import {
  assertMigrationSlotTransition,
  assertSourceMigrationTransition,
  canTransitionMigrationSlot,
  canTransitionSourceMigration,
  isTerminalMigrationSlotStatus,
  isTerminalSourceMigrationStatus
} from './circleMigrationStateMachine';

describe('Circle migration state machines', () => {
  it('allows the destination happy path and idempotent repeats', () => {
    const path = [
      'pending',
      'verified',
      'reserved',
      'importing',
      'imported',
      'waiting_cutover',
      'activating',
      'active'
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionMigrationSlot(path[index]!, path[index + 1]!)).toBe(true);
    }
    expect(canTransitionMigrationSlot('reserved', 'reserved')).toBe(true);
    expect(isTerminalMigrationSlotStatus('active')).toBe(true);
  });

  it('rejects activation before a verified import', () => {
    expect(() => assertMigrationSlotTransition('pending', 'active')).toThrow(
      'Invalid migration slot transition'
    );
    expect(canTransitionMigrationSlot('revoked', 'verified')).toBe(false);
  });

  it('allows the source happy path but no abort after cutover', () => {
    expect(canTransitionSourceMigration('waiting_cutover', 'cutover')).toBe(true);
    expect(canTransitionSourceMigration('cutover', 'migrated')).toBe(true);
    expect(canTransitionSourceMigration('cutover', 'aborted')).toBe(false);
    expect(() => assertSourceMigrationTransition('migrated', 'aborted')).toThrow(
      'Invalid source migration transition'
    );
    expect(isTerminalSourceMigrationStatus('migrated')).toBe(true);
  });
});
