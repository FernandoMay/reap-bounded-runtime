/**
 * SQLite persistence.
 *
 * SQLite is the right call here for a specific reason, not convenience: a
 * spending limit is only meaningful if the decision that consumed budget and
 * the record of what happened cannot drift apart. A single local database with
 * synchronous writes and a unique constraint on the idempotency key gives that
 * without standing up a server. The budget reservation in `reserveBudget` runs
 * inside a transaction, which is what actually makes concurrent purchases safe
 * — the application-level check alone would still race.
 *
 * Money is stored as TEXT in major units, matching `SerializedMoney`. Never as
 * a REAL: SQLite's floating point would reintroduce exactly the drift the money
 * module exists to prevent, and it would do it in the one place nobody checks.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  deserialize,
  redactValue,
  serialize,
  stateFromCheckoutStatus,
  type AuditEvent,
  type Checkout,
  type Money,
  type Policy,
  type PolicyDecision,
  type PurchaseIntent,
  type PurchaseRecord,
  type PurchaseState,
  type Quote,
  type RuntimeMode,
} from '@bounded/core';

/** The window shapes `Policy.budgetWindow` can take. */
type BudgetWindow = NonNullable<Policy['budgetWindow']>;

/**
 * JSON encoding for anything that crosses into SQLite or the audit trail.
 *
 * Every monetary amount here is a `bigint`, and `JSON.stringify` throws on
 * bigint by default. Serialising through `redactValue` handles both concerns in
 * one pass: bigints become decimal strings, and any secret-shaped field is
 * destroyed before it can be written down.
 */
const encode = (value: unknown): string => {
  const encoded = JSON.stringify(redactValue(value));
  // `JSON.stringify(undefined)` yields undefined, not a string. An optional
  // field that is absent must still be storable, and storing the literal text
  // "undefined" would fail to parse on read and poison the whole record.
  return encoded === undefined ? 'null' : encoded;
};

/**
 * Read a stored JSON column.
 *
 * Returns `undefined` for NULL or a stored JSON `null`, and throws for
 * anything genuinely malformed. A corrupt row should stop the request loudly
 * rather than be silently reinterpreted as an absent field — for a purchase
 * record, quietly dropping the checkout would misrepresent a pending charge.
 */
function parseColumn(raw: string | undefined, name: string): unknown {
  if (raw === undefined || raw === null || raw === 'null') return undefined;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`column ${name} does not contain valid JSON`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS purchases (
  id                TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL UNIQUE,
  agent_id          TEXT NOT NULL,
  state             TEXT NOT NULL,
  intent_json       TEXT NOT NULL,
  decision_json     TEXT NOT NULL,
  quote_json        TEXT,
  checkout_json     TEXT,
  reserved_currency TEXT,
  reserved_amount   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- The idempotency guarantee is enforced here, not in application logic. Two
-- concurrent requests with the same key race in Node; they cannot race here.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  purchase_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  data_json   TEXT,
  FOREIGN KEY (purchase_id) REFERENCES purchases (id)
);

CREATE INDEX IF NOT EXISTS idx_purchases_state ON purchases (state);
CREATE INDEX IF NOT EXISTS idx_purchases_agent ON purchases (agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_purchase ON audit_events (purchase_id, at);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly policy: Policy;
}

/**
 * The start of the current budget window, or `undefined` for a lifetime budget.
 *
 * Windows are anchored on calendar boundaries in UTC rather than on a rolling
 * interval from first use. Both readings of "monthly budget" exist, but a
 * calendar month is the one an operator can check against a statement, and a
 * rolling window that resets the moment the agent spends would be surprising to
 * reconcile. UTC keeps the boundary identical for every deployment regardless
 * of where it runs.
 */
export function windowStart(window: BudgetWindow, now: Date): Date | undefined {
  switch (window) {
    case 'LIFETIME':
      return undefined;
    case 'DAY':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case 'WEEK': {
      // ISO weeks start on Monday, which is why the shift is (day + 6) % 7.
      const midnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      midnight.setUTCDate(midnight.getUTCDate() - ((midnight.getUTCDay() + 6) % 7));
      return midnight;
    }
    case 'MONTH':
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    default:
      return undefined;
  }
}

export class Store {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    // Enforce the foreign key rather than leaving it as documentation.
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- agents and policy ---------------------------------------------------

  upsertAgent(agent: Agent, now: string): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, policy_json, created_at)
         VALUES (@id, @name, @policy, @now)
         ON CONFLICT(id) DO UPDATE SET name = @name, policy_json = @policy`,
      )
      .run({ id: agent.id, name: agent.name, policy: encode(agent.policy), now });
  }

  getAgent(agentId: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | { id: string; name: string; policy_json: string }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, policy: JSON.parse(row.policy_json) as Policy };
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Array<{
      id: string;
      name: string;
      policy_json: string;
    }>;
    return rows.map((row) => ({ id: row.id, name: row.name, policy: JSON.parse(row.policy_json) }));
  }

  // --- idempotency ---------------------------------------------------------

  /**
   * Claim an idempotency key.
   *
   * Returns the existing purchase id when the key was already used, and `null`
   * when this caller is the first and should proceed. The insert is atomic, so
   * concurrent retries of the same intent produce exactly one purchase rather
   * than two checkouts for one request.
   */
  claimIdempotencyKey(key: string, purchaseId: string, now: string): string | null {
    const insert = this.db
      .prepare('INSERT OR IGNORE INTO idempotency_keys (key, purchase_id, created_at) VALUES (?, ?, ?)')
      .run(key, purchaseId, now);
    if (insert.changes > 0) return null;

    const existing = this.db.prepare('SELECT purchase_id FROM idempotency_keys WHERE key = ?').get(key) as
      | { purchase_id: string }
      | undefined;
    return existing?.purchase_id ?? null;
  }

  // --- purchases -----------------------------------------------------------

  insertPurchase(record: PurchaseRecord): void {
    this.db
      .prepare(
        `INSERT INTO purchases (
           id, idempotency_key, agent_id, state, intent_json, decision_json,
           quote_json, checkout_json, reserved_currency, reserved_amount,
           created_at, updated_at
         ) VALUES (
           @id, @idempotency_key, @agent_id, @state, @intent, @decision,
           @quote, @checkout, @reserved_currency, @reserved_amount,
           @created_at, @updated_at
         )`,
      )
      .run(this.toParams(record));
  }

  updatePurchase(record: PurchaseRecord): void {
    const result = this.db
      .prepare(
        `UPDATE purchases SET
           state = @state, decision_json = @decision, quote_json = @quote,
           checkout_json = @checkout, reserved_currency = @reserved_currency,
           reserved_amount = @reserved_amount, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(this.toParams(record));
    if (result.changes === 0) {
      throw new Error(`purchase ${record.id} not found`);
    }
  }

  getPurchase(id: string): PurchaseRecord | undefined {
    const row = this.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as
      | Record<string, string>
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  listPurchases(limit = 50): PurchaseRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, string>>;
    return rows.map((row) => this.fromRow(row));
  }

  private toParams(record: PurchaseRecord): Record<string, string | null> {
    return {
      id: record.id,
      idempotency_key: record.idempotencyKey,
      agent_id: record.agentId,
      state: record.state,
      intent: encode(record.intent),
      decision: encode(record.decision),
      quote: record.quote ? encode(record.quote) : null,
      checkout: record.checkout ? encode(record.checkout) : null,
      reserved_currency: record.reservedAmount?.currency ?? null,
      reserved_amount: record.reservedAmount ? serialize(record.reservedAmount).amount : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  private fromRow(row: Record<string, string>): PurchaseRecord {
    // Column names carry the `_json` suffix the schema declares. Reading
    // `row.intent` instead of `row.intent_json` returns undefined, and because
    // the optional fields are guarded by truthiness that failure is silent:
    // every purchase would come back with its quote and checkout missing.
    const intent = parseColumn(row['intent_json'], 'intent_json');
    const decision = parseColumn(row['decision_json'], 'decision_json');
    const quote = parseColumn(row['quote_json'], 'quote_json');
    const checkout = parseColumn(row['checkout_json'], 'checkout_json');

    return {
      id: row['id'] as string,
      idempotencyKey: row['idempotency_key'] as string,
      agentId: row['agent_id'] as string,
      state: row['state'] as PurchaseState,
      intent: intent as PurchaseIntent,
      decision: decision as PolicyDecision,
      ...(quote ? { quote: quote as Quote } : {}),
      ...(checkout ? { checkout: checkout as Checkout } : {}),
      ...(row['reserved_amount'] && row['reserved_currency']
        ? { reservedAmount: deserialize({ amount: row['reserved_amount'], currency: row['reserved_currency'] }) }
        : {}),
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  // --- budget --------------------------------------------------------------

  /**
   * Totals that consume budget: anything settled, plus anything still in flight.
   *
   * `reserved` is what closes the concurrency hole. Two purchases approved in
   * the same instant each pass an application-level check against `settled`
   * alone, then together exceed the budget. Counting the second one as reserved
   * makes the second check fail.
   *
   * Scoped by window as well. Without the `created_at` cutoff a MONTH budget
   * kept counting purchases from previous months, so the ceiling drifted upward
   * without bound and stopped being a ceiling at all.
   */
  budgetUsage(
    agentId: string,
    currency: string,
    window: BudgetWindow = 'LIFETIME',
    now: Date = new Date(),
  ): { settled: Money; reserved: Money; since: string | null } {
    const since = windowStart(window, now)?.toISOString() ?? null;

    const settledRows = this.db
      .prepare(
        `SELECT reserved_amount AS amount FROM purchases
         WHERE state = 'COMPLETED' AND reserved_currency = ? AND agent_id = ?
           AND (? IS NULL OR created_at >= ?)`,
      )
      .all(currency, agentId, since, since) as Array<{ amount: string }>;

    const reservedRows = this.db
      .prepare(
        `SELECT reserved_amount AS amount FROM purchases
         WHERE state IN ('RECEIVED', 'QUOTED', 'CHECKOUT_PENDING', 'PROCESSING')
           AND reserved_currency = ? AND agent_id = ?
           AND (? IS NULL OR created_at >= ?)`,
      )
      .all(currency, agentId, since, since) as Array<{ amount: string }>;

    // Totalled through the money module, never by multiplying a parsed float by
    // 100. The stored value is the exact decimal the provider quoted, and
    // parsing it as a double before scaling would silently corrupt a budget.
    const total = (rows: Array<{ amount: string }>): bigint =>
      rows.reduce(
        (sum, row) => sum + deserialize({ amount: row.amount, currency }).minor,
        0n,
      );

    return {
      settled: { minor: total(settledRows), currency },
      reserved: { minor: total(reservedRows), currency },
      since,
    };
  }

  // --- audit ---------------------------------------------------------------

  appendAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, purchase_id, at, type, summary, data_json)
         VALUES (@id, @purchase_id, @at, @type, @summary, @data)`,
      )
      .run({
        id: event.id,
        purchase_id: event.purchaseId,
        at: event.at,
        type: event.type,
        summary: event.summary,
        data: event.data ? encode(event.data) : null,
      });
  }

  listAudit(purchaseId: string): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE purchase_id = ? ORDER BY at')
      .all(purchaseId) as Array<Record<string, string>>;
    return rows.map((row) => ({
      id: row['id'] as string,
      purchaseId: row['purchase_id'] as string,
      at: row['at'] as string,
      type: row['type'] as string,
      summary: row['summary'] as string,
      ...(row['data_json']
        ? { data: parseColumn(row['data_json'], 'data_json') as Record<string, unknown> }
        : {}),
    }));
  }

  // --- runtime metadata ----------------------------------------------------

  setMeta(key: string, value: string): void {
    // Named parameters throughout. The upsert clause also references `@value`,
    // and mixing positional and named placeholders in one statement leaves that
    // reference unbound.
    this.db
      .prepare(
        `INSERT INTO runtime_meta (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = @value`,
      )
      .run({ key, value });
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM runtime_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}

export { stateFromCheckoutStatus };
export type { RuntimeMode };
