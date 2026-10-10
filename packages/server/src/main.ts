/**
 * Process entry point.
 *
 * Configuration is resolved and validated before anything binds a port. A
 * runtime that starts with a missing API key and fails on the first purchase is
 * worse than one that refuses to start, because the failure looks like a
 * provider outage.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { createProvider, loadReapConfig, loadRuntimeSettings } from '@bounded/provider';

import { buildServer } from './server.js';
import { Store } from './store.js';
import { seedDemoAgent } from './seed.js';

/**
 * Minimal .env loader, so local runs do not need an extra dependency.
 *
 * Searches upward from the working directory. Workspace scripts run with the
 * package directory as cwd, so a single `./.env` lookup would miss the file at
 * the repository root and the runtime would refuse to start for a reason that
 * looks like a missing credential.
 */
function loadDotEnv(): void {
  const path = findUpward('.env');
  if (!path) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Walk up from `start` looking for `name`, stopping at the filesystem root. */
function findUpward(name: string, start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const settings = loadRuntimeSettings();
  const reapConfig = settings.mode === 'sandbox' ? loadReapConfig() : undefined;
  const { provider, mode } = createProvider(reapConfig);

  const store = new Store(settings.databasePath);
  store.setMeta('mode', mode);

  // A demo agent exists so the runtime is usable the moment it starts. Its
  // policy is deliberately tight: the defaults should refuse most things.
  seedDemoAgent(store);

  const app = buildServer({
    store,
    provider,
    mode,
    apiToken: settings.apiToken,
    logLevel: settings.logLevel,
  });

  await app.listen({ port: settings.port, host: settings.host });

  app.log.info(
    { mode, provider: provider.description, database: settings.databasePath },
    mode === 'mock'
      ? 'Bounded Agent Runtime started in MOCK mode. No network calls, no real charges.'
      : 'Bounded Agent Runtime started in SANDBOX mode against Reap.',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start: ${message}\n`);
  process.exitCode = 1;
});
