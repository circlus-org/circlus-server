import '../env';

import { initializeDatabase, closeDatabase } from '../db';
import { cleanupExpiredUnacceptedInvites } from '../utils/cleanup';
import { loadCliDatabaseRuntimeConfig } from '../config/cliRuntimeConfig';

async function main() {
  const { databaseUrl } = loadCliDatabaseRuntimeConfig();

  try {
    initializeDatabase(databaseUrl);
    const deleted = await cleanupExpiredUnacceptedInvites();
    console.log(`[InviteCleanup] Done. Deleted expired unaccepted invites: ${deleted}`);
  } catch (error) {
    console.error('[InviteCleanup] Script failed:', error);
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabase();
    } catch {
      // ignore shutdown errors
    }
  }
}

void main();
