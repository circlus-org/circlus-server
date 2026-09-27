#!/usr/bin/env node
import { requestTurnCredentials } from './lib/ice-smoke.mjs';

try {
  const turn = await requestTurnCredentials();
  console.log(`ICE credential issuance passed for TURN cluster: ${turn.turnClusterId}`);
  console.log('This does not test TURN authentication, relay traffic or public reachability.');
} catch (error) {
  console.error(`ICE smoke test failed: ${error.message}`);
  process.exitCode = 1;
}
