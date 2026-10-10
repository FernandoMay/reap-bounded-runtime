/**
 * Provider configuration, resolved from the environment and validated once at
 * startup.
 *
 * Two rules shape this file.
 *
 * Fail fast. A misconfigured runtime refuses to start. A payments service that
 * discovers its API key is missing when the first request arrives has already
 * failed in the most expensive way available.
 *
 * Never send a simulation header to production. `X-Simulate-Checkout` makes
 * Reap settle a charge with nobody clicking the approval page. Reap rejects it
 * on production hosts, but relying on the provider to stop us is the wrong
 * division of responsibility, so the client refuses to build the header at all
 * when the base URL points anywhere near production.
 */

import type { RuntimeMode } from '@bounded/core';

export type AmountSemantics = 'MAJOR' | 'MINOR';

export interface ReapConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly version: string;
  readonly timeoutMs: number;
  /** Present only in sandbox mode; rejected outright against production. */
  readonly simulateCheckout?: 'COMPLETED';
  readonly amountSemantics: AmountSemantics;
  readonly mode: RuntimeMode;
}

/**
 * Build a config, enforcing the production rule even when the caller assembled
 * the fields itself. Prefer this over a bare object literal so the invariant
 * cannot be bypassed by an embedding application.
 */
export function defineReapConfig(config: ReapConfig): ReapConfig {
  if (config.simulateCheckout && isProductionHost(config.baseUrl)) {
    throw new ConfigurationError(
      'simulateCheckout is set against a production host. Simulated checkout settles charges ' +
        'without human approval and must never run against a live environment.',
    );
  }
  return config;
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

/** Hosts for which the simulation header is forbidden. */
const PRODUCTION_HOST_PATTERNS = [
  /^api\.reap\.global$/,
  /^sg\.prod\.api\.reap\.global$/,
  /^mx\.prod\.api\.reap\.global$/,
  /^prod\.api\.reap\.global$/,
];

export function isProductionHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigurationError(`${key} is required but not set`);
  return value;
}

function parseBooleanish(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Build the configuration for the real Reap provider.
 *
 * Throws `ConfigurationError` rather than degrading. Callers that want the mock
 * provider should ask for it explicitly, not receive it because a key was
 * missing — a silent downgrade to a fixture provider is how a demo turns into
 * an incident.
 */
export function loadReapConfig(env: NodeJS.ProcessEnv = process.env): ReapConfig {
  const baseUrl = requireEnv(env, 'REAP_BASE_URL').replace(/\/+$/, '');
  const apiKey = requireEnv(env, 'REAP_API_KEY');
  const version = env['REAP_VERSION']?.trim() || '2025-02-14';

  const timeoutRaw = Number.parseInt(env['REAP_TIMEOUT_MS'] ?? '', 10);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 15_000;

  const semantics = (env['REAP_AMOUNT_SEMANTICS'] ?? 'MAJOR').toUpperCase();
  if (semantics !== 'MAJOR' && semantics !== 'MINOR') {
    throw new ConfigurationError(`REAP_AMOUNT_SEMANTICS must be MAJOR or MINOR, got "${semantics}"`);
  }

  const simulateRaw = env['REAP_SIMULATE_CHECKOUT']?.trim().toUpperCase();

  if (isProductionHost(baseUrl)) {
    if (simulateRaw) {
      throw new ConfigurationError(
        'REAP_SIMULATE_CHECKOUT is set but REAP_BASE_URL points at production. ' +
          'Simulated checkout settles charges without human approval and must never run against a live environment.',
      );
    }
  }

  const config: ReapConfig = {
    baseUrl,
    apiKey,
    version,
    timeoutMs,
    ...(simulateRaw === 'COMPLETED' && !isProductionHost(baseUrl)
      ? { simulateCheckout: 'COMPLETED' as const }
      : {}),
    amountSemantics: semantics,
    mode: 'sandbox',
  };

  return config;
}

export interface RuntimeSettings {
  readonly mode: RuntimeMode;
  readonly apiToken: string;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Resolve server settings.
 *
 * There is no anonymous mode. `RUNTIME_API_TOKEN` is mandatory: this API can
 * move an agent closer to a real charge, and an unauthenticated endpoint on a
 * development machine is how a laptop on hotel wifi becomes someone else's
 * expense.
 */
export function loadRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  const mode = (env['RUNTIME_MODE'] ?? 'mock').toLowerCase();
  if (mode !== 'mock' && mode !== 'sandbox') {
    throw new ConfigurationError(`RUNTIME_MODE must be mock or sandbox, got "${mode}"`);
  }

  const apiToken = requireEnv(env, 'RUNTIME_API_TOKEN');
  if (apiToken.length < 16) {
    throw new ConfigurationError('RUNTIME_API_TOKEN must be at least 16 characters');
  }

  if (mode === 'sandbox' && !parseBooleanish(env['ALLOW_INSECURE_SANDBOX'], false)) {
    if (!env['REAP_API_KEY']?.trim()) {
      throw new ConfigurationError(
        'RUNTIME_MODE=sandbox requires REAP_API_KEY. Use RUNTIME_MODE=mock for fixture-backed runs.',
      );
    }
  }

  const port = Number.parseInt(env['PORT'] ?? '', 10);
  const logLevel = (env['LOG_LEVEL'] ?? 'info').toLowerCase();

  return {
    mode,
    apiToken,
    host: env['HOST']?.trim() || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    databasePath: env['DATABASE_PATH']?.trim() || './data/runtime.sqlite',
    logLevel: (['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error',
  };
}
