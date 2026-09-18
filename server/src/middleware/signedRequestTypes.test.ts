import { ACCESS_OPERATION_PATHS, accessResource } from '../../../shared/accessOperations';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { verifySignature } from './auth';
import { getHttpSignedRequestType, HTTP_SIGNED_REQUEST_TYPES } from './signedRequestTypes';

describe('HTTP signed operation contract', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  test('every mounted device-authenticated route has an explicit operation and no stale entries remain', () => {
    // Load actual routers without importing index.ts, which starts the server.
    const entry = ts.createSourceFile('index.ts', fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map<string, string>();
    for (const statement of entry.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause?.name && ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.set(statement.importClause.name.text, statement.moduleSpecifier.text);
      }
    }
    const routes: string[] = [];
    function inspect(stack: any[], baseUrl: string) {
      for (const layer of stack) {
        if (layer.route?.stack.some((middleware: any) => middleware.handle === verifySignature)) {
          for (const method of Object.keys(layer.route.methods)) {
            const key = `${method.toUpperCase()} ${baseUrl}${layer.route.path}`;
            expect({ key, type: getHttpSignedRequestType(method.toUpperCase(), baseUrl, layer.route.path) })
              .toEqual({ key, type: expect.any(String) });
            const type = HTTP_SIGNED_REQUEST_TYPES[key];
            if (ACCESS_OPERATION_PATHS[type]) {
              expect(key).toBe('POST /api' + ACCESS_OPERATION_PATHS[type]);
              expect(layer.route.stack.some((middleware: any) => middleware.handle.accessVersioned === true)).toBe(true);
            }
            routes.push(key);
          }
        } else if (layer.handle?.stack) {
          // Current child routers are mounted without another path prefix.
          expect(layer.regexp.fast_slash).toBe(true);
          inspect(layer.handle.stack, baseUrl);
        }
      }
    }
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(entry) === 'app.use') {
        const [prefix, router] = node.arguments;
        if (prefix && ts.isStringLiteral(prefix) && router && ts.isIdentifier(router)) {
          const source = imports.get(router.text);
          if (source?.startsWith('./routes/')) {
            inspect(require(path.resolve(__dirname, '..', source)).default.stack, prefix.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(entry);
    for (const [type, route] of Object.entries(ACCESS_OPERATION_PATHS)) expect(HTTP_SIGNED_REQUEST_TYPES['POST /api'+route]).toBe(type);
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.sort()).toEqual(Object.keys(HTTP_SIGNED_REQUEST_TYPES).sort());
  });

  test('recovery extra fields cannot redirect the version check to a different slot', () => {
    const binding = {payload:{recoverySlot:'android_google_restore_v1'}};
    const revocation = {payload:{recoverySlot:'ios_icloud_synced_key_v1'}};
    expect(accessResource('platform-recovery:revoke-device', '/device-enrollments/platform-recovery/revoke',
      {binding,revocation}, 'alice')).toBe(accessResource('platform-recovery:revoke-device',
      '/device-enrollments/platform-recovery/revoke', {revocation}, 'alice'));
    expect(accessResource('platform-recovery:bind-device', '/device-enrollments/platform-recovery/bind',
      {binding,revocation}, 'alice')).toBe(accessResource('platform-recovery:bind-device',
      '/device-enrollments/platform-recovery/bind', {binding}, 'alice'));
  });

  test('different operations cannot silently share a signed type', () => {
    const types = Object.values(HTTP_SIGNED_REQUEST_TYPES);
    expect(new Set(types).size).toBe(types.length);
  });

  test('distinguishes reads and writes on the same path and handles literal colons', () => {
    expect(getHttpSignedRequestType('POST', '/api/admin', '/family-config')).toBe('admin:family-config:get');
    expect(getHttpSignedRequestType('PUT', '/api/admin', '/family-config')).toBe('admin:family-config:update');
    expect(getHttpSignedRequestType('POST', '/api/group-chats', '/:chatId/participants\\:add')).toBe('grp:participants:add');
    expect(getHttpSignedRequestType('DELETE', '/api/admin', '/family-config')).toBeUndefined();
  });
});
