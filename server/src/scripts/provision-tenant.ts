#!/usr/bin/env tsx
import '../env';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { initializeDatabase, closeDatabase } from '../db';
import { familyConfigRepository, familyDomainRepository, inviteRepository, tenantOwnerClaimsRepository } from '../db/repositories';
import { normalizeHost } from '../middleware/tenancy';
import { createOpaqueClaimToken, hashClaimToken } from '../utils/claimTokens';
import { loadCliDatabaseRuntimeConfig } from '../config/cliRuntimeConfig';
import {
  booleanArgument,
  boundedIntegerArgument,
  splitCliArgument
} from './cliArgumentParsing';

type Options = {
  host: string;
  serverName: string;
  noNamesOnServer: boolean;
  ownerClaimTtlHours: number;
  joinInviteTtlHours: number;
};

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    host: '',
    serverName: 'Family Server',
    noNamesOnServer: false,
    ownerClaimTtlHours: 72,
    joinInviteTtlHours: 72
  };

  for (const arg of args) {
    const { key, value } = splitCliArgument(arg);
    if (key === '--host') {
      options.host = normalizeHost(value || '');
    } else if (key === '--server-name') {
      options.serverName = value || options.serverName;
    } else if (key === '--no-names-on-server') {
      options.noNamesOnServer = booleanArgument(value, key, false);
    } else if (key === '--owner-claim-ttl-hours') {
      options.ownerClaimTtlHours = boundedIntegerArgument({
        value,
        name: key,
        defaultValue: 72,
        min: 1,
        max: 365 * 24
      });
    } else if (key === '--join-invite-ttl-hours') {
      options.joinInviteTtlHours = boundedIntegerArgument({
        value,
        name: key,
        defaultValue: 72,
        min: 1,
        max: 365 * 24
      });
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!options.host) {
    throw new Error('--host is required');
  }

  return options;
}

async function main() {
  const { databaseUrl } = loadCliDatabaseRuntimeConfig();
  const options = parseArgs();
  initializeDatabase(databaseUrl);

  try {
    const existingDomain = await familyDomainRepository.findByHost(options.host);
    if (existingDomain) {
      throw new Error(`tenant already exists for host ${options.host}`);
    }
    const familyId = randomUUID();

    const joinInviteToken = `join_${nanoid(24)}`;
    const ownerClaimToken = createOpaqueClaimToken('toc');
    const inviteId = `invite_${nanoid(18)}`;
    const joinInviteExpiresAt = new Date(Date.now() + options.joinInviteTtlHours * 60 * 60 * 1000);
    const ownerClaimExpiresAt = new Date(Date.now() + options.ownerClaimTtlHours * 60 * 60 * 1000);

    await familyConfigRepository.create({
      familyId,
      serverName: options.serverName,
      publicBaseUrl: `https://${options.host}`,
      noNamesOnServer: options.noNamesOnServer,
      provisionStatus: 'pending_owner',
      joinInviteId: inviteId,
    });

    await familyDomainRepository.createPrimaryDomain({
      familyId,
      host: options.host,
      publicBaseUrl: `https://${options.host}`,
      source: 'provision-script'
    });

    await inviteRepository.create({
      familyId,
      inviteId,
      token: joinInviteToken,
      createdBy: 'system',
      expiresAt: joinInviteExpiresAt,
      maxUses: 1
    });

    await tenantOwnerClaimsRepository.create({
      familyId,
      tokenHash: hashClaimToken(ownerClaimToken),
      expiresAt: ownerClaimExpiresAt
    });

    console.log('Tenant provisioned');
    console.log(`Host: ${options.host}`);
    console.log(`Family ID: ${familyId}`);
    console.log(`Join invite token: ${joinInviteToken}`);
    console.log(`Join invite expires at: ${joinInviteExpiresAt.toISOString()}`);
    console.log(`Owner claim token: ${ownerClaimToken}`);
    console.log(`Owner claim expires at: ${ownerClaimExpiresAt.toISOString()}`);
  } finally {
    await closeDatabase();
  }
}

main().catch(async (error) => {
  console.error('Failed to provision tenant:', error);
  await closeDatabase();
  process.exit(1);
});
