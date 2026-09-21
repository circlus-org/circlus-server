import fs from 'fs';
import path from 'path';

const serverSourceRoot = path.resolve(__dirname, '..');

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(absolute);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [absolute]
      : [];
  });
}

describe('Circle role mutation trust boundary', () => {
  test('does not expose a direct role-assignment route', () => {
    const routeSources = filesUnder(path.join(serverSourceRoot, 'routes'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(routeSources).not.toContain("'/users/:identityId/role'");
    expect(routeSources).not.toContain('identityRepository.updateRole(');
    expect(fs.existsSync(path.join(serverSourceRoot, 'routes', 'tenantOwnerClaims.ts'))).toBe(false);
  });

  test('keeps direct SQL role projection writes inside signed membership services', () => {
    const roleWriteFiles = [
      ...filesUnder(path.join(serverSourceRoot, 'routes')),
      ...filesUnder(path.join(serverSourceRoot, 'services')),
    ]
      .filter((file) => /UPDATE\s+identities\s+SET\s+role\s*=/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(serverSourceRoot, file))
      .sort();

    expect(roleWriteFiles).toEqual([
      'services/circleOwnershipService.ts',
      'services/memberIdentityRegistrationService.ts',
    ]);
  });
});
