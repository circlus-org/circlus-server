#!/usr/bin/env tsx
import '../env';
import { initializeDatabase, closeDatabase } from '../db';
import { familyConfigRepository } from '../db/repositories';
import { loadCliDatabaseRuntimeConfig } from '../config/cliRuntimeConfig';
import { formatTenantList, type TenantListSummary } from './tenant-list-format';

function parseJsonFlag(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--json') return true;
  throw new Error(`Unknown argument: ${args[0]}`);
}

async function main() {
  const json = parseJsonFlag(process.argv.slice(2));
  const { databaseUrl } = loadCliDatabaseRuntimeConfig();
  initializeDatabase(databaseUrl);

  try {
    const circles = await familyConfigRepository.listWithStats();
    const summaries: TenantListSummary[] = circles.map((circle) => ({
      familyId: circle.family_id,
      circleId: circle.circle_id,
      name: circle.server_name,
      host: circle.current_domain_host,
      status: circle.status,
      activeMembers: circle.active_member_identity_count,
      activeGuests: circle.active_guest_identity_count,
      totalIdentities: circle.identity_count,
      activeDevices: circle.active_device_count
    }));

    if (json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }

    console.log(formatTenantList(summaries));
  } finally {
    await closeDatabase();
  }
}

main().catch(async (error) => {
  console.error('Failed to list Circles:', error instanceof Error ? error.message : error);
  await closeDatabase();
  process.exit(1);
});
