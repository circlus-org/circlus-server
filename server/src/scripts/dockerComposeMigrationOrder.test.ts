import fs from 'node:fs';
import path from 'node:path';

describe('Public Docker Compose deployment', () => {
  const composePath = path.resolve(process.cwd(), '..', 'compose.yaml');
  const compose = fs.readFileSync(
    composePath,
    'utf8'
  );

  it('uses the root compose file as the canonical public deployment', () => {
    expect(fs.existsSync(composePath)).toBe(true);
  });

  it('runs database migrations before starting the server', () => {
    const migrateService = compose.indexOf('\n  migrate:\n');
    const serverService = compose.indexOf('\n  server:\n');
    const migrateCommand = compose.indexOf(
      'command: ["npm", "run", "migrate:prod"]',
      migrateService
    );
    const serverDependsOn = compose.indexOf('    depends_on:', serverService);
    const migrateDependency = compose.indexOf('      migrate:', serverDependsOn);
    const completionCondition = compose.indexOf(
      'condition: service_completed_successfully',
      migrateDependency
    );

    expect(migrateService).toBeGreaterThan(-1);
    expect(serverService).toBeGreaterThan(migrateService);
    expect(migrateCommand).toBeGreaterThan(migrateService);
    expect(migrateCommand).toBeLessThan(serverService);
    expect(serverDependsOn).toBeGreaterThan(serverService);
    expect(migrateDependency).toBeGreaterThan(serverDependsOn);
    expect(completionCondition).toBeGreaterThan(migrateDependency);
  });

  it('persists filesystem-backed server data outside the container layer', () => {
    const serverService = compose.indexOf('\n  server:\n');
    const serverDataMount = compose.indexOf(
      '      - server_data:/app/server/server-data',
      serverService
    );
    const volumeDeclaration = compose.indexOf('\n  server_data:\n');

    expect(serverService).toBeGreaterThan(-1);
    expect(serverDataMount).toBeGreaterThan(serverService);
    expect(volumeDeclaration).toBeGreaterThan(serverDataMount);
  });

  it('checks database-backed readiness and runs the image as a non-root user', () => {
    expect(compose).toContain('http://localhost:3000/ready');
    const dockerfile = fs.readFileSync(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/\nUSER node\n/);
  });
});
