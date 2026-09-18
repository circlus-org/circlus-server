jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

import { lookup } from 'node:dns/promises';
import { assertSafePublicHttpUrl, isBlockedIpAddress, safeHttpFetch } from './safeHttpFetch';

describe('safeHttpFetch SSRF guards', () => {
  test('rejects a DNS AAAA answer mapping to loopback before connecting', async () => {
    (lookup as jest.Mock).mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);
    await expect(assertSafePublicHttpUrl(new URL('http://preview.example/'))).rejects.toThrow('Private URLs');
    await expect(safeHttpFetch('http://preview.example/', { timeoutMs: 100, maxBytes: 100 })).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledWith('preview.example', { all: true, verbatim: true });
  });

  test.each([
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:7f00:0001', '::ffff:a00:1',
    '0000:0000:0000:0000:0000:0000:0000:0001', '[::ffff:c0a8:1]'
  ])('blocks alternate private IPv6 spelling %s', async (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
    const host = address.startsWith('[') ? address : `[${address}]`;
    await expect(assertSafePublicHttpUrl(new URL(`http://${host}/`))).rejects.toThrow('Private URLs');
  });

  test('allows public IPv4-mapped IPv6', () => {
    expect(isBlockedIpAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIpAddress('::ffff:808:808')).toBe(false);
  });

  test('blocks private and special IPv4 ranges', () => {
    expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('10.1.2.3')).toBe(true);
    expect(isBlockedIpAddress('172.16.0.1')).toBe(true);
    expect(isBlockedIpAddress('192.168.1.1')).toBe(true);
    expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
    expect(isBlockedIpAddress('8.8.8.8')).toBe(false);
  });

  test('blocks private and special IPv6 ranges', () => {
    expect(isBlockedIpAddress('::1')).toBe(true);
    expect(isBlockedIpAddress('[::1]')).toBe(true);
    expect(isBlockedIpAddress('fc00::1')).toBe(true);
    expect(isBlockedIpAddress('fd00::1')).toBe(true);
    expect(isBlockedIpAddress('fe80::1')).toBe(true);
    expect(isBlockedIpAddress('2001:4860:4860::8888')).toBe(false);
  });

  test('rejects localhost hostnames and non-http protocols', async () => {
    await expect(assertSafePublicHttpUrl(new URL('http://localhost/'))).rejects.toThrow('Private URLs');
    await expect(assertSafePublicHttpUrl(new URL('http://app.localhost/'))).rejects.toThrow('Private URLs');
    await expect(assertSafePublicHttpUrl(new URL('file:///etc/passwd'))).rejects.toThrow('Only http/https');
  });
});
