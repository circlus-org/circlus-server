import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

const explicitEnvFile = process.env.ENV_FILE;

const candidates = explicitEnvFile
  ? [path.resolve(explicitEnvFile)]
  : [
      // Most common: run from server/ and load server/.env
      path.resolve(process.cwd(), '.env'),
      // If running compiled JS from dist/, __dirname is dist/; this finds server/.env
      path.resolve(__dirname, '..', '.env'),
      // If running from repo root, this finds server/.env
      path.resolve(process.cwd(), 'server', '.env')
    ];

const envPath = firstExistingPath(candidates);
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  // Fall back to default dotenv behavior (looks for .env in cwd)
  dotenv.config();
}

export const resolvedEnvPath: string | null = envPath;
