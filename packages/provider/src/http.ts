/**
 * HTTP transport for the Reap API.
 *
 * Responsibilities kept in one place so that no caller can forget them:
 * authentication, the version header, idempotency, bounded timeouts, and the
 * translation of every failure into a typed error.
 *
 * Secrets are never logged, never put in an error message, and never included
 * in a thrown object's inspected fields. The `Authorization` header is attached
 * at the last possible moment and stripped from anything that gets recorded.
 */

import {
  parseReapError,
  redactHeaders,
  redactString,
  ReapProtocolError,
  ReapTransportError,
  type ReapApiError,
} from '@bounded/core';

import type { ReapConfig } from './config.js';

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Required on enrollments, quotes and checkouts. */
  readonly idempotencyKey?: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface HttpLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: HttpLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Error raised when the request exceeded our own deadline.
 *
 * A distinct type from `ReapTransportError` because it carries a different
 * operational meaning: a timeout says the merchant or the network stalled, not
 * that the request was malformed. Callers retry those differently.
 */
export class ReapTimeoutError extends Error {
  override readonly name = 'ReapTimeoutError' as typeof ReapTransportError.prototype.name;
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
  }
}

export class ReapClient {
  constructor(
    private readonly config: ReapConfig,
    private readonly logger: HttpLogger = NOOP_LOGGER,
    /** Injectable for tests; defaults to the global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const url = new URL(`${this.config.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Reap-Version': this.config.version,
      Accept: 'application/json',
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;

    if (this.config.simulateCheckout) {
      headers['X-Simulate-Checkout'] = this.config.simulateCheckout;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const started = Date.now();
    this.logger.debug('reap.request', {
      method: request.method,
      path: request.path,
      headers: redactHeaders(headers),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = controller.signal.aborted;
      const detail = aborted
        ? `no response within ${this.config.timeoutMs}ms`
        : redactString(cause instanceof Error ? cause.message : 'connection failed');
      this.logger.error('reap.transport_failure', { path: request.path, aborted });
      // The cause is deliberately not attached: it can carry the request URL,
      // and the URL of a failed request to a payments API is not something to
      // propagate into a log line or a client response.
      throw aborted ? new ReapTimeoutError(detail) : new ReapTransportError(detail);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - started;
    this.logger.debug('reap.response', {
      path: request.path,
      status: response.status,
      durationMs,
    });

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new ReapProtocolError(
        `Reap returned a ${response.status} on ${request.path} with a body that is not JSON`,
      );
    }

    if (!response.ok) {
      throw parseReapError(response.status, raw, response.headers);
    }

    return { status: response.status, body: raw as T, headers: response.headers };
  }
}

export type { ReapApiError };
