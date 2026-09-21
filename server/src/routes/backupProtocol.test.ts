import fs from 'node:fs';
import path from 'node:path';

describe('Backup protocol cutover', () => {
  it('rejects legacy uploads', () => {
    const route = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/backup.ts'), 'utf8');

    expect(route).toMatch(/payload\.backupProtocolVersion !== 2/);
    expect(route).toMatch(/body\.backupProtocolVersion !== 2/);
  });

  const clientPath = path.resolve(process.cwd(), '../client/src/api/client.ts');
  if (fs.existsSync(clientPath)) it('uses backup protocol v2 in the bundled client', () => {
    const client = fs.readFileSync(clientPath, 'utf8');
    expect(client).toMatch(/backupProtocolVersion: 2/);
  });
});
