import '../env';
import { initializeServerRuntimeConfig } from './serverRuntimeConfig';

// This module is imported before routes and WebSocket handlers by the server
// entry point, so every runtime subsystem observes the same validated snapshot.
export const runtimeConfig = initializeServerRuntimeConfig();
