import fs from 'fs';
import path from 'path';

const routesDir = __dirname;

function routeSource(fileName: string): string {
  return fs.readFileSync(path.join(routesDir, fileName), 'utf8');
}

describe('identity suspension remains an access boundary', () => {
  test('device-signed mutation routes require an active identity unless they only remove a push binding', () => {
    const uncoveredRoutes: string[] = [];

    for (const fileName of fs.readdirSync(routesDir)) {
      if (!fileName.endsWith('.ts') || fileName.endsWith('.test.ts')) continue;
      const source = routeSource(fileName);
      const routePattern = /router\.(?:post|put|delete)\(/g;
      let match: RegExpExecArray | null;

      while ((match = routePattern.exec(source)) !== null) {
        const handlerStart = source.indexOf('async (', match.index);
        if (handlerStart < 0) continue;
        const middlewareChain = source.slice(match.index, handlerStart);
        const isSigned = middlewareChain.includes('verifySignature')
          || middlewareChain.includes('verifyDeviceSignature');
        if (!isSigned || middlewareChain.includes('requireActiveIdentity')) continue;

        const isPushUnbind = fileName === 'mobile.ts'
          && middlewareChain.includes("'/devices/bindings/unbind'");
        if (!isPushUnbind) {
          const line = source.slice(0, match.index).split('\n').length;
          uncoveredRoutes.push(`${fileName}:${line}`);
        }
      }
    }

    expect(uncoveredRoutes).toEqual([]);
  });

  test('mobile call bootstrap validates both the identity and the device', () => {
    const mobileSource = routeSource('mobile.ts');
    const bootstrapStart = mobileSource.indexOf("router.post('/calls/bootstrap'");
    const statusStart = mobileSource.indexOf("router.post('/calls/status'", bootstrapStart);
    const bootstrapRoute = mobileSource.slice(bootstrapStart, statusStart);

    expect(bootstrapRoute).toContain('identityRepository.findByIdentityId');
    expect(bootstrapRoute).toContain("localIdentity.status !== 'active'");
    expect(bootstrapRoute).toContain("device.status !== 'active'");
  });
});
