#!/usr/bin/env tsx
import '../env';
import { initializeDatabase, closeDatabase } from '../db';
import { serverAdminRepository } from '../db/repositories';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { loadCliDatabaseRuntimeConfig } from '../config/cliRuntimeConfig';
import { boundedIntegerArgument, splitCliArgument } from './cliArgumentParsing';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { ttlHours: number; note?: string } = { ttlHours: 1 };

  for (const arg of args) {
    const { key, value } = splitCliArgument(arg);
    if (key === '--ttl-hours') {
      out.ttlHours = boundedIntegerArgument({
        value,
        name: '--ttl-hours',
        defaultValue: 1,
        min: 1,
        max: 365 * 24
      });
    } else if (key === '--note') {
      out.note = value || '';
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  return out;
}

async function main() {
  const { databaseUrl } = loadCliDatabaseRuntimeConfig();
  const options = parseArgs();
  initializeDatabase(databaseUrl);

  try {
    const claimToken = createOpaqueClaimToken('sac');
    const expiresAt = new Date(Date.now() + options.ttlHours * 60 * 60 * 1000);
    await serverAdminRepository.createClaim({
      tokenHash: hashClaimToken(claimToken),
      expiresAt,
      note: options.note || null
    });

    console.log('Server admin claim created');
    console.log(`Expires at: ${expiresAt.toISOString()}`);
    console.log(`Claim token: ${claimToken}`);
  } finally {
    await closeDatabase();
  }
}

main().catch(async (error) => {
  console.error('Failed to create server admin claim:', error);
  await closeDatabase();
  process.exit(1);
});
