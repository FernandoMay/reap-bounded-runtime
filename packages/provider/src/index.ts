export * from './types.js';
export * from './config.js';
export * from './http.js';
export { ReapAgenticProvider } from './reap/client.js';
export { MockProvider, MockProviderError, type MockScenario } from './mock/provider.js';

import type { ReapConfig } from './config.js';
import { MockProvider } from './mock/provider.js';
import { ReapAgenticProvider } from './reap/client.js';
import type { PaymentProvider } from './types.js';

export interface ResolvedProvider {
  readonly provider: PaymentProvider;
  readonly mode: 'sandbox' | 'mock';
}

/**
 * Choose a provider from configuration.
 *
 * The downgrade is explicit and loud. A missing credential produces an error,
 * never a silent fall back to fixtures — the alternative is a demo that quietly
 * stops testing the thing it claims to test.
 */
export function createProvider(config: ReapConfig | undefined): ResolvedProvider {
  if (!config) {
    return { provider: new MockProvider(), mode: 'mock' };
  }
  return { provider: new ReapAgenticProvider(config), mode: 'sandbox' };
}
