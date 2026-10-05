import type { AuthRequest } from '../middleware/auth';
import { getRequestIp } from './deviceEnrollmentRouteSupport';

test('enrollment records the Express client IP rather than an untrusted forwarded header', () => {
  const req = {
    ip: '203.0.113.5',
    headers: { 'x-forwarded-for': '198.51.100.20' }
  } as unknown as AuthRequest;

  expect(getRequestIp(req)).toBe('203.0.113.5');
});
