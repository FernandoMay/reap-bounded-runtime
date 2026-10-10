import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  api,
  ApiError,
  hasToken,
  setToken,
  type AuditEvent,
  type Health,
  type PolicyDecision,
  type PurchaseState,
  type WirePurchase,
} from './api';

/** Format minor units for display without ever doing float arithmetic. */
function formatAmount(amount: { amount: string; currency: string } | undefined): string {
  if (!amount) return '—';
  // The API sends an integer count of minor units as a string. Splitting the
  // digits is the only safe way to render it.
  const minor = amount.amount;
  const isNegative = minor.startsWith('-');
  const digits = isNegative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const units = padded.slice(0, -2);
  const cents = padded.slice(-2);
  return `${isNegative ? '-' : ''}${units}.${cents} ${amount.currency}`;
}

const STATE_TONE: Record<PurchaseState, string> = {
  RECEIVED: 'neutral',
  QUOTED: 'info',
  CHECKOUT_PENDING: 'warning',
  PROCESSING: 'info',
  POLICY_DENIED: 'danger',
  COMPLETED: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
};

/**
 * The mode banner.
 *
 * Present and unmissable, because the difference between "this ran against a
 * real Reap sandbox" and "this ran against fixtures" is the difference between
 * a demo and a simulation of a demo. A reader should never have to check the
 * console to know which one they are looking at.
 */
function ModeBanner({ health }: { health: Health | null }) {
  if (!health) return null;
  const isMock = health.mode === 'mock';

  return (
    <div className={`banner ${isMock ? 'banner-mock' : 'banner-sandbox'}`} role="status">
      <strong>{isMock ? 'MOCK MODE — FIXTURES, NO NETWORK' : 'SANDBOX MODE — REAL REAP API'}</strong>
      <span>{health.provider.description}</span>
      {isMock && (
        <span className="banner-note">
          Nothing here touches a payment provider. Switch RUNTIME_MODE=sandbox with REAP_API_KEY set to
          exercise the real integration.
        </span>
      )}
    </div>
  );
}

function TokenGate({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="gate">
      <h1>Bounded Agent Runtime</h1>
      <p className="muted">
        Every request to this API requires the runtime token. It is kept in this tab only and never
        written to disk.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length < 16) {
            setError('The token is at least 16 characters.');
            return;
          }
          setToken(value.trim());
          onUnlock(value.trim());
        }}
      >
        <input
          type="password"
          value={value}
          placeholder="RUNTIME_API_TOKEN"
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        <button type="submit">Unlock</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function DecisionPanel({ decision }: { decision: PolicyDecision }) {
  return (
    <div className="panel">
      <h3>Policy decision</h3>
      <p className={decision.allowed ? 'verdict-allow' : 'verdict-deny'}>
        {decision.allowed ? 'ALLOWED' : `DENIED — ${decision.code}`}
      </p>
      {decision.message && <p className="muted">{decision.message}</p>}
      <table className="rules">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Result</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {decision.outcomes.map((outcome) => (
            <tr key={outcome.rule} className={outcome.passed ? 'pass' : 'fail'}>
              <td>{outcome.rule}</td>
              <td>{outcome.passed ? 'pass' : 'FAIL'}</td>
              <td>{outcome.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTrail({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="panel">
      <h3>Audit trail</h3>
      <ol className="audit">
        {events.map((event) => (
          <li key={event.id}>
            <code>{event.type}</code>
            <span>{event.summary}</span>
            <time>{new Date(event.at).toLocaleTimeString()}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PurchaseRow({
  purchase,
  selected,
  onSelect,
}: {
  purchase: WirePurchase;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={selected ? 'selected' : ''} onClick={onSelect}>
      <td>
        <span className={`state state-${STATE_TONE[purchase.state]}`}>{purchase.state}</span>
      </td>
      <td>{purchase.intent.items.map((item) => item.variantId).join(', ')}</td>
      <td>{formatAmount(purchase.quote?.finalAmount ?? purchase.checkout?.amount)}</td>
      <td>{purchase.checkout?.orderId ?? '—'}</td>
      <td>{new Date(purchase.createdAt).toLocaleTimeString()}</td>
    </tr>
  );
}

function NewPurchaseForm({
  agents,
  onCreated,
}: {
  agents: Array<{ id: string; name: string }>;
  onCreated: (id: string) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [variantId, setVariantId] = useState('var_mock_coffee');
  const [email, setEmail] = useState('buyer@example.com');
  const [quantity, setQuantity] = useState(1);
  const [enrollmentId, setEnrollmentId] = useState('enr_mock_active');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      // A fresh key per submission is what a real calling agent would do for a
      // new intent; resubmitting the same key is how idempotency gets tested.
      const idempotencyKey = crypto.randomUUID();
      const result = await api.purchase({
        agentId,
        idempotencyKey,
        enrollmentId,
        returnUrl: `${window.location.origin}/approved`,
        intent: { items: [{ variantId, quantity }], email },
      });
      onCreated(result.purchase.id);
      setMessage({
        tone: result.outcome === 'denied' ? 'err' : 'ok',
        text:
          result.outcome === 'awaiting_approval'
            ? `Checkout opened. Approve at the hosted page, then press Sync. ${result.approvalUrl ?? ''}`
            : result.outcome === 'denied'
              ? `Policy denied the purchase: ${result.decision?.code ?? 'unknown reason'}`
              : `Outcome: ${result.outcome}`,
      });
    } catch (error) {
      setMessage({
        tone: 'err',
        text: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h3>Request a purchase</h3>
      <div className="grid">
        <label>
          Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Variant
          <input value={variantId} onChange={(e) => setVariantId(e.target.value)} />
        </label>
        <label>
          Quantity
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label>
          Purchaser email
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Enrollment
          <input value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)} />
        </label>
      </div>
      <button type="submit" disabled={busy || !agentId}>
        {busy ? 'Working…' : 'Request purchase'}
      </button>
      {message && <p className={message.tone === 'ok' ? 'ok' : 'error'}>{message.text}</p>}
    </form>
  );
}

export function App() {
  const [unlocked, setUnlocked] = useState(hasToken());
  const [health, setHealth] = useState<Health | null>(null);
  const [purchases, setPurchases] = useState<WirePurchase[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ purchase: WirePurchase; audit: AuditEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [healthResult, purchasesResult, agentsResult] = await Promise.all([
        api.health(),
        api.listPurchases(),
        api.listAgents(),
      ]);
      setHealth(healthResult);
      setPurchases(purchasesResult.purchases);
      setAgents(agentsResult);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, []);

  useEffect(() => {
    if (unlocked) void refresh();
  }, [unlocked, refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void api
      .getPurchase(selectedId)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [selectedId, purchases]);

  const sync = async () => {
    const checkoutId = detail?.purchase.checkout?.id;
    if (!checkoutId) return;
    setSyncing(true);
    try {
      // Sync reads the provider back. It never approves anything: if the human
      // has not approved, the provider still reports the charge as pending.
      const result = await api.sync(checkoutId);
      setDetail((current) => (current ? { ...current, purchase: result.purchase } : current));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const selected = useMemo(
    () => purchases.find((purchase) => purchase.id === selectedId),
    [purchases, selectedId],
  );

  if (!unlocked) return <TokenGate onUnlock={() => setUnlocked(true)} />;

  return (
    <main>
      <header>
        <h1>Bounded Agent Runtime</h1>
        <ModeBanner health={health} />
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <NewPurchaseForm
        agents={agents}
        onCreated={(id) => {
          setSelectedId(id);
          void refresh();
        }}
      />

      <section className="panel">
        <div className="panel-head">
          <h3>Purchases</h3>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <table className="purchases">
          <thead>
            <tr>
              <th>State</th>
              <th>Items</th>
              <th>Amount</th>
              <th>Order</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((purchase) => (
              <PurchaseRow
                key={purchase.id}
                purchase={purchase}
                selected={purchase.id === selectedId}
                onSelect={() => setSelectedId(purchase.id)}
              />
            ))}
          </tbody>
        </table>
        {purchases.length === 0 && <p className="muted">No purchases yet.</p>}
      </section>

      {detail && (
        <section>
          <DecisionPanel decision={detail.purchase.decision} />

          <div className="panel">
            <h3>Lifecycle</h3>
            <dl>
              <dt>Purchase</dt>
              <dd>
                <code>{detail.purchase.id}</code>
              </dd>
              <dt>Idempotency key</dt>
              <dd>
                <code>{detail.purchase.idempotencyKey}</code>
              </dd>
              <dt>Quote</dt>
              <dd>{detail.purchase.quote?.id ?? '—'}</dd>
              <dt>Merchant</dt>
              <dd>{detail.purchase.quote?.merchant.name ?? '—'}</dd>
              <dt>Amount</dt>
              <dd>{formatAmount(detail.purchase.checkout?.finalAmount ?? detail.purchase.quote?.finalAmount)}</dd>
              <dt>Checkout status</dt>
              <dd>{detail.purchase.checkout?.status ?? '—'}</dd>
              <dt>Order reference</dt>
              <dd>{detail.purchase.checkout?.orderId ?? 'not settled'}</dd>
            </dl>

            {detail.purchase.checkout?.approvalUrl && (
              <p>
                <a href={detail.purchase.checkout.approvalUrl} target="_blank" rel="noreferrer">
                  Approve on the provider page
                </a>
              </p>
            )}
            {selected?.state === 'CHECKOUT_PENDING' && (
              <button type="button" onClick={() => void sync()} disabled={syncing}>
                {syncing ? 'Syncing…' : 'Sync with provider'}
              </button>
            )}
          </div>

          <AuditTrail events={detail.audit} />
        </section>
      )}
    </main>
  );
}
