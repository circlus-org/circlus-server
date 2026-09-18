import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger';

describe('structured logger', () => {
  it('keeps the entire production runtime on the structured logging API', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const files = listRuntimeTypeScriptFiles(sourceRoot);
    const offenders = files
      .filter((file) => /console\.(?:log|info|warn|error)/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(sourceRoot, file));

    expect(offenders).toEqual([]);
  });

  it('writes structured JSON with child context and serialized errors', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      format: 'json',
      service: 'test-service',
      now: () => new Date('2026-08-17T10:00:00.000Z'),
      write: (line) => lines.push(line)
    }).child({ component: 'websocket' });

    logger.error('message_failed', {
      callSessionId: 'call-1',
      error: new Error('boom')
    });

    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      timestamp: '2026-08-17T10:00:00.000Z',
      level: 'error',
      service: 'test-service',
      event: 'message_failed',
      component: 'websocket',
      callSessionId: 'call-1',
      error: expect.objectContaining({ name: 'Error', message: 'boom' })
    }));
  });

  it('redacts sensitive values recursively', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      format: 'json',
      service: 'test-service',
      write: (line) => lines.push(line)
    });

    logger.info('credentials_received', {
      authorization: 'Bearer value',
      operationId: 'private-operation-id',
      nested: { sharedSecret: 'secret', safe: 'visible' }
    });

    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      authorization: '[REDACTED]',
      operationId: '[REDACTED]',
      nested: { sharedSecret: '[REDACTED]', safe: 'visible' }
    }));
  });

  it('honors the configured minimum level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      format: 'pretty',
      service: 'test-service',
      write: (line) => lines.push(line)
    });

    logger.info('ignored');
    logger.warn('written', { identityId: 'identity-1' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN test-service written');
  });
});

function listRuntimeTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'scripts' ? [] : listRuntimeTypeScriptFiles(file);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return [file];
  });
}
