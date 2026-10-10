/**
 * API client for the runtime.
 *
 * The bearer token is held in memory for the life of the tab and is never
 * written to storage. `localStorage` would survive the tab closing and leave a
 * credential that can authorise purchases sitting on disk for any script on the
 * origin to read.
 *
 * No `VITE_`-prefixed environment variable is used for the token either. Vite
 * inlines those into the built JavaScript, which is the same problem in a more
 * permanent form.
 */

const TOKEN_STORAGE_KEY = 'bounded-runtime-token';

export interface WireAmount {
  amount: string;
  currency: string;
}

export type PurchaseState =
  | 'RECEIVED'
  | 'POLICY_DENIED'
  | 'QUOTED'
  | 'CHECKOUT_PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export interface RuleOutcome {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface PolicyDecision {
  allowed: boolean;
  code?: string;
  message?: string;
  outcomes: RuleOutcome[];
}

export interface WireCheckout {
  id: string;
  status: string;
  amount: WireAmount;
  approvalUrl?: string;
  orderId?: string;
  finalAmount?: WireAmount;
}

export interface WirePurchase {
  id: string;
  idempotencyKey: string;
  agentId: string;
  state: PurchaseState;
  createdAt: string;
  updatedAt: string;
  intent: {
    items: { variantId: string; quantity: number }[];
    email: string;
    shippingAddress?: Record<string, string>;
    rationale?: string;
  };
  decision: PolicyDecision;
  quote?: {
    id: string;
    merchant: { name: string };
    finalAmount: WireAmount;
    expiresAt: string;
  };
  checkout?: WireCheckout;
}

export interface AuditEvent {
  id: string;
  at: string;
  type: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface Health {
  ok: boolean;
  mode: 'sandbox' | 'mock';
  provider: { kind: string; description: string };
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

function getToken(): string {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

export function setToken(token: string): void {
  // sessionStorage is scoped to the tab and cleared when it closes. Still not a
  // secret store, but the right trade-off for a local operator console.
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function hasToken(): boolean {
  return getToken() !== '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string; detail?: unknown } };
    throw new ApiError(
      envelope.error?.code ?? 'HTTP_ERROR',
      envelope.error?.message ?? `request failed with ${response.status}`,
      response.status,
      envelope.error?.detail,
    );
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  listPurchases: () => request<{ purchases: WirePurchase[] }>('/api/purchases'),
  getPurchase: (id: string) =>
    request<{ purchase: WirePurchase; audit: AuditEvent[] }>(`/api/purchases/${id}`),
  listAgents: () =>
    request<Array<{ id: string; name: string; policy: Record<string, unknown> }>>('/api/agents'),
  search: (query: string) =>
    request<{
      results: Array<{
        id: string;
        name: string;
        merchantName: string;
        previewVariant?: { id: string; price: WireAmount };
      }>;
    }>('/api/catalog/search', {
      method: 'POST',
      body: JSON.stringify({ query, country: 'US', currency: 'USD' }),
    }),
  purchase: (body: {
    agentId: string;
    idempotencyKey: string;
    enrollmentId: string;
    returnUrl: string;
    intent: {
      items: { variantId: string; quantity: number }[];
      email: string;
      shippingAddress?: Record<string, string>;
    };
  }) =>
    request<{ outcome: string; purchase: WirePurchase; approvalUrl?: string; decision?: PolicyDecision }>(
      '/api/purchases',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  sync: (checkoutId: string) =>
    request<{ purchase: WirePurchase }>(`/api/checkouts/${checkoutId}/sync`, { method: 'POST' }),
};
