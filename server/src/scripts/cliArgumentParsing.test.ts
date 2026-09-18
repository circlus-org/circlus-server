import {
  booleanArgument,
  boundedIntegerArgument,
  splitCliArgument
} from './cliArgumentParsing';

describe('CLI argument parsing', () => {
  it('preserves equals signs in argument values', () => {
    expect(splitCliArgument('--note=source=manual')).toEqual({
      key: '--note',
      value: 'source=manual'
    });
    expect(splitCliArgument('--flag')).toEqual({ key: '--flag', value: undefined });
  });

  it('accepts only bounded integers', () => {
    expect(boundedIntegerArgument({
      value: '72', name: '--ttl-hours', defaultValue: 1, min: 1, max: 100
    })).toBe(72);
    expect(() => boundedIntegerArgument({
      value: '1.5', name: '--ttl-hours', defaultValue: 1, min: 1, max: 100
    })).toThrow('--ttl-hours must be an integer');
    expect(() => boundedIntegerArgument({
      value: '101', name: '--ttl-hours', defaultValue: 1, min: 1, max: 100
    })).toThrow('--ttl-hours must be between 1 and 100');
  });

  it('accepts explicit boolean values only', () => {
    expect(booleanArgument('true', '--enabled', false)).toBe(true);
    expect(booleanArgument('false', '--enabled', true)).toBe(false);
    expect(() => booleanArgument('yes', '--enabled', false))
      .toThrow('--enabled must be true or false');
  });
});
