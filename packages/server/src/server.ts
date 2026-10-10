/**
 * HTTP surface.
 *
 * Every route requires a bearer token. There is no anonymous read, no
 * unauthenticated health detail, and no CORS wildcard: this API moves an agent
 * closer to a real charge, and a development machine on an untrusted network
 * should not be one `curl` away from authorising a purchase.
 *
 * Errors are translated once, at the edge, into a stable envelope. Internal
 * detail is redacted on the way out, because a stack trace or a provider message
 * is exactly the sort of thing that ends up in a screenshot.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  redactString,
  type Policy,
  type PurchaseRecord,
  type RuntimeMode,
  type ShippingAddress,
} from '@bounded/core';
import type { PaymentProvider } from '@bounded/provider';
import Fastify, { type FastifyInstance } from 'fastify';

import { PurchaseError, PurchaseService } from './service.js';
import { Store } from './store.js';

export interface ServerOptions {
  readonly store: Store;
  readonly provider: PaymentProvider;
  readonly mode: RuntimeMode;
  readonly apiToken: string;
  readonly logLevel?: string;
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail?: unknown;
  };
}

/**
 * Constant-time comparison, so a wrong token cannot be discovered by timing.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and that throw is
 * itself a length oracle. Hashing both sides first gives two fixed-width
 * digests to compare, which closes it.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Shape a purchase for the wire. Money crosses as a string, never a float. */
function serializePurchase(record: PurchaseRecord): Record<string, unknown> {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    agentId: record.agentId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    intent: {
      items: record.intent.items,
      email: record.intent.email,
      ...(record.intent.shippingAddress ? { shippingAddress: record.intent.shippingAddress } : {}),
      ...(record.intent.rationale ? { rationale: record.intent.rationale } : {}),
    },
    decision: record.decision,
    ...(record.quote
      ? {
          quote: {
            id: record.quote.id,
            merchant: record.quote.merchant,
            finalAmount: {
              amount: String(record.quote.amountBreakdown.finalAmount.minor),
              currency: record.quote.amountBreakdown.finalAmount.currency,
            },
            shippingOptions: record.quote.shippingOptions.map((option) => ({
              id: option.id,
              name: option.name,
              selected: option.selected,
              price: { amount: String(option.price.minor), currency: option.price.currency },
            })),
            expiresAt: record.quote.expiresAt,
          },
        }
      : {}),
    ...(record.checkout
      ? {
          checkout: {
            id: record.checkout.id,
            status: record.checkout.status,
            amount: {
              amount: String(record.checkout.amount.minor),
              currency: record.checkout.amount.currency,
            },
            ...(record.checkout.approvalUrl ? { approvalUrl: record.checkout.approvalUrl } : {}),
            ...(record.checkout.orderId ? { orderId: record.checkout.orderId } : {}),
            ...(record.checkout.finalAmount
              ? {
                  finalAmount: {
                    amount: String(record.checkout.finalAmount.minor),
                    currency: record.checkout.finalAmount.currency,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The fixture provider's extra capability.
 *
 * Kept as a separate structural type rather than importing MockProvider, so the
 * server does not depend on the fixture implementation. The route that uses it
 * is registered only in mock mode, so in sandbox it simply does not exist.
 */
interface MockSettler {
  approveCheckout(checkoutId: string): Promise<unknown>;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });
  const service = new PurchaseService(options.store, options.provider, options.mode);

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      await reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'a bearer token is required' } } satisfies ErrorEnvelope);
      return;
    }
    if (!tokenMatches(header.slice('Bearer '.length).trim(), options.apiToken)) {
      await reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN', message: 'invalid API token' } } satisfies ErrorEnvelope);
    }
  });

  // One place where every failure becomes a response. Anything that reaches here
  // is already logged; the client gets a code and a redacted message.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PurchaseError) {
      return reply
        .code(error.httpStatus)
        .send({ error: { code: error.code, message: error.message, detail: error.detail } } satisfies ErrorEnvelope);
    }

    // A typed provider error (Reap or the mock) carries a code and often a
    // remedy explaining what to change. Pass the remedy through: it is the
    // difference between "the request failed" and "add shippingAddress.region".
    const providerError = error as { code?: unknown; message?: unknown; remedy?: unknown };
    if (typeof providerError.code === 'string' && /^[A-Z_]+$/.test(providerError.code)) {
      return reply
        .code(400)
        .send({
          error: {
            code: providerError.code,
            message: redactString(String(providerError.message ?? 'provider request failed')),
            ...(typeof providerError.remedy === 'string' ? { detail: providerError.remedy } : {}),
          },
        } satisfies ErrorEnvelope);
    }

    // Log the redacted message only. A raw stack or provider payload can carry
    // request internals that do not belong in a log sink.
    request.log.error({ err: redactString(String((error as { message?: unknown }).message ?? error)) }, 'unhandled error');
    return reply
      .code(500)
      .send({
        error: { code: 'INTERNAL_ERROR', message: 'the request could not be completed' },
      } satisfies ErrorEnvelope);
  });

  // Provenance. A reader of the dashboard must be able to tell real sandbox
  // activity from fixtures without inspecting the environment.
  app.get('/api/health', async () => ({
    ok: true,
    mode: options.mode,
    provider: { kind: options.provider.kind, description: options.provider.description },
  }));

  app.get('/api/agents', async () => options.store.listAgents());

  app.post<{ Body: { id: string; name: string; policy: Policy } }>('/api/agents', async (request, reply) => {
    const { id, name, policy } = request.body ?? {};
    if (!id || !name || !policy) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'id, name and policy are required' },
      } satisfies ErrorEnvelope);
    }
    options.store.upsertAgent({ id, name, policy }, new Date().toISOString());
    return reply.code(201).send({ id, name, policy });
  });

  app.post<{
    Body: {
      agentId: string;
      intent: Record<string, unknown>;
      idempotencyKey: string;
      enrollmentId: string;
      returnUrl: string;
    };
  }>('/api/purchases', async (request, reply) => {
    const { agentId, intent, idempotencyKey, enrollmentId, returnUrl } = request.body ?? {};

    if (!agentId || !intent || !idempotencyKey || !enrollmentId || !returnUrl) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'agentId, intent, idempotencyKey, enrollmentId and returnUrl are all required',
        },
      } satisfies ErrorEnvelope);
    }
    if (!returnUrl.startsWith('https://') && !returnUrl.startsWith('http://localhost')) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'returnUrl must be an https URL, or http://localhost during development',
        },
      } satisfies ErrorEnvelope);
    }

    const outcome = await service.purchase({
      agentId,
      intent: intent as never,
      idempotencyKey,
      enrollmentId,
      returnUrl,
    });

    const body = {
      outcome: outcome.kind,
      purchase: serializePurchase(outcome.purchase),
      ...(outcome.kind === 'awaiting_approval' ? { approvalUrl: outcome.approvalUrl } : {}),
      ...(outcome.kind === 'denied' ? { decision: outcome.decision } : {}),
    };

    // A denial is a successful evaluation, not a failed request: the runtime
    // did its job and refused. 200 with the reason is more useful to a calling
    // agent than 4xx with a generic body.
    return reply.code(outcome.kind === 'denied' ? 200 : 201).send(body);
  });

  app.get<{ Params: { id: string } }>('/api/purchases/:id', async (request, reply) => {
    const record = service.get(request.params.id);
    if (!record) {
      return reply.code(404).send({
        error: { code: 'PURCHASE_NOT_FOUND', message: 'no such purchase' },
      } satisfies ErrorEnvelope);
    }
    return { purchase: serializePurchase(record), audit: service.auditFor(record.id) };
  });

  app.get('/api/purchases', async (request) => ({
    purchases: service.list(100).map(serializePurchase),
  }));

  /**
   * Read the provider back. Called after the user returns from the hosted
   * approval page; it is what turns a pending charge into a settled one.
   */
  app.post<{ Params: { checkoutId: string } }>(
    '/api/checkouts/:checkoutId/sync',
    async (request, reply) => {
      const record = await service.sync(request.params.checkoutId);
      return { purchase: serializePurchase(record) };
    },
  );

  /**
   * Simulate the human approving on the hosted page — mock mode only.
   *
   * This route is registered only when the provider is the fixture provider.
   * Against a real Reap sandbox it does not exist, and that is the point: an
   * "approve this charge" endpoint would be a backdoor that lets a caller
   * settle a purchase with nobody present. In sandbox mode the only way to
   * approve is for a person to click through Reap's own hosted page.
   */
  if (options.mode === 'mock') {
    const approve = (options.provider as Partial<MockSettler>).approveCheckout;
    if (typeof approve === 'function') {
      const settle = approve.bind(options.provider);
      app.post<{ Body: { checkoutId: string } }>('/api/mock/approve', async (request, reply) => {
        const checkoutId = request.body?.checkoutId;
        if (!checkoutId) {
          return reply.code(400).send({
            error: { code: 'INVALID_REQUEST', message: 'checkoutId is required' },
          } satisfies ErrorEnvelope);
        }
        await settle(checkoutId);
        return { approved: true, note: 'Fixture settlement. No provider was contacted.' };
      });
    }
  }

  app.get<{ Params: { checkoutId: string } }>('/api/checkouts/:checkoutId', async (request, reply) => {
    const record = service.list(1000).find((p) => p.checkout?.id === request.params.checkoutId);
    if (!record?.checkout) {
      return reply.code(404).send({
        error: { code: 'CHECKOUT_NOT_FOUND', message: 'no such checkout' },
      } satisfies ErrorEnvelope);
    }
    return {
      checkout: {
        id: record.checkout.id,
        status: record.checkout.status,
        orderId: record.checkout.orderId,
      },
    };
  });

  app.post<{ Body: { query: string; country?: string; currency?: string; limit?: number } }>(
    '/api/catalog/search',
    async (request, reply) => {
      const { query, country = 'US', currency = 'USD', limit = 10 } = request.body ?? {};
      if (typeof query !== 'string' || query.trim() === '') {
        return reply.code(400).send({
          error: { code: 'INVALID_REQUEST', message: 'a non-empty query is required' },
        } satisfies ErrorEnvelope);
      }
      const result = await options.provider.searchProducts({ query, context: { country, currency }, limit });
      return result;
    },
  );

  app.get<{ Params: { enrollmentId: string } }>('/api/enrollments/:enrollmentId', async (request, reply) => {
    const enrollment = await options.provider.getEnrollment(request.params.enrollmentId);
    return { enrollment };
  });

  return app;
}

export type { ShippingAddress };
