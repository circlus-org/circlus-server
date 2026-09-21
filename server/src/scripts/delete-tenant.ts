#!/usr/bin/env tsx
import '../env';
import { initializeDatabase, closeDatabase } from '../db';
import { familyConfigRepository, familyDomainRepository, identityRepository } from '../db/repositories';
import { loadCliDatabaseRuntimeConfig } from '../config/cliRuntimeConfig';
import { normalizeHost } from '../middleware/tenancy';
import { attachmentStorageService } from '../services/attachmentStorageService';
import { publicSiteAssetStorageService } from '../services/publicSiteAssetStorageService';
import {
  confirmTenantDeletion,
  parseDeleteTenantOptions,
  selectTenantDomain
} from './delete-tenant-options';

async function deleteStoredFiles(storageKeys: {
  attachmentStorageKeys: string[];
  publicSiteAssetStorageKeys: string[];
}): Promise<string[]> {
  const failures: string[] = [];
  for (const storageKey of storageKeys.attachmentStorageKeys) {
    try {
      await attachmentStorageService.deleteBlob(storageKey);
    } catch {
      failures.push(`attachment:${storageKey}`);
    }
  }
  for (const storageKey of storageKeys.publicSiteAssetStorageKeys) {
    try {
      await publicSiteAssetStorageService.deleteAsset(storageKey);
    } catch {
      failures.push(`public-site:${storageKey}`);
    }
  }
  return failures;
}

async function main() {
  const options = parseDeleteTenantOptions(process.argv.slice(2));
  const host = normalizeHost(options.host);
  if (!host) throw new Error('--host must contain a valid hostname');

  const { databaseUrl } = loadCliDatabaseRuntimeConfig();
  initializeDatabase(databaseUrl);

  try {
    const domains = await familyDomainRepository.listByHost(host);
    const domain = selectTenantDomain(domains, options.familyId);
    const circle = await familyConfigRepository.findByFamilyId(domain.family_id);
    if (!circle) throw new Error(`Circle ${domain.family_id} has no configuration row`);
    const identityCount = await identityRepository.count(domain.family_id);

    console.log('Circle selected for permanent deletion');
    console.log(`Host: ${host}`);
    console.log(`Name: ${circle.server_name}`);
    console.log(`Family ID: ${domain.family_id}`);
    console.log(`Circle ID: ${circle.circle_id}`);
    console.log(`Status: ${circle.status}`);
    console.log(`Registered identities: ${identityCount}`);

    if (!confirmTenantDeletion(domain.family_id, options.confirmFamilyId)) {
      console.log('No data was changed. Re-run with:');
      console.log(`npm run tenant:delete -- --host=${host} --family-id=${domain.family_id} --confirm-family-id=${domain.family_id}`);
      console.log('In the Docker container use tenant:delete:prod with the same arguments.');
      return;
    }

    const storageKeys = await familyConfigRepository.deleteWithData(domain.family_id);
    const fileCleanupFailures = await deleteStoredFiles(storageKeys);
    console.log(`Circle ${domain.family_id} was permanently deleted`);
    if (fileCleanupFailures.length > 0) {
      throw new Error(`Database deletion completed, but ${fileCleanupFailures.length} stored files could not be deleted: ${fileCleanupFailures.join(', ')}`);
    }
  } finally {
    await closeDatabase();
  }
}

main().catch(async (error) => {
  console.error('Failed to delete Circle:', error instanceof Error ? error.message : error);
  await closeDatabase();
  process.exit(1);
});
