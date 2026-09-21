import fs from 'fs';
import path from 'path';

describe('encrypted attachment reservation metadata', () => {
  test('does not accept or persist the client filename or MIME type', () => {
    const source = fs.readFileSync(path.join(__dirname, 'attachments.ts'), 'utf8');
    const reservationStart = source.indexOf("router.post('/reservations'");
    const uploadStart = source.indexOf("router.put('/uploads/:blobId'");
    const reservationSource = source.slice(reservationStart, uploadStart);

    expect(reservationStart).toBeGreaterThanOrEqual(0);
    expect(uploadStart).toBeGreaterThan(reservationStart);
    expect(reservationSource).not.toContain('payload.filename');
    expect(reservationSource).not.toContain('payload.mimeType');
    expect(reservationSource).not.toContain('originalFileName');
    expect(reservationSource).not.toContain('mimeType');
  });
});
