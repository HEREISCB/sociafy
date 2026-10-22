'use client';

import { useState } from 'react';
import type { CreditsPayload } from '../../../../../components/credits';
import { Button, Empty, Skeleton, useToast } from '../../../../../components/ui';
import { friendlyApiError, useApi } from '../../../../../lib/ui/fetcher';
import { groupLedger, type CycleSummary, type LedgerTone } from '../../../../../lib/ui/ledgerLabel';
import { num, shortDate, signed } from '../../../../../components/billing/account-ui';

type Payload = CreditsPayload & { hasMore: boolean; cycle?: CycleSummary };
type Filter = 'all' | LedgerTone;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'spent', label: 'Spent' },
  { id: 'added', label: 'Added' },
  { id: 'refund', label: 'Refunds' },
];
// Ink, the one accent, then greys and the ok green: distinct without a rainbow.
const SWATCH = ['var(--text)', 'var(--accent)', '#8A8A82', '#C9C8C0', 'var(--ok-ink)', 'var(--line-strong)'];

function dayLabel(day: string): string {
  const today = new Date().toLocaleDateString('en-CA');
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  const d = shortDate(`${day}T12:00:00`);
  return day === today ? `Today · ${d}` : day === yesterday ? `Yesterday · ${d}` : d;
}

export default function UsagePage() {
  const { data, isLoading } = useApi<Payload>('/api/credits?cycle=1');
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [older, setOlder] = useState<{ rows: Payload['ledger']; hasMore: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const rows = [...(data?.ledger ?? []), ...(older?.rows ?? [])];
  const hasMore = older ? older.hasMore : !!data?.hasMore;
  const days = groupLedger(rows);
  const cycle = data?.cycle;
  const since = data?.creditCycleStart ? shortDate(data.creditCycleStart) : null;
  const spentTotal = cycle?.byCategory.reduce((a, c) => a + c.credits, 0) ?? 0;

  const loadOlder = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/credits?before=${encodeURIComponent(last.createdAt)}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const page = (await r.json()) as Payload;
      setOlder({ rows: [...(older?.rows ?? []), ...page.ledger], hasMore: page.hasMore });
    } catch (e) {
      toast(friendlyApiError(e), { tone: 'err' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="acct-page">
      <div className="acct-math" aria-label={since ? `This cycle, since ${since}` : 'This cycle'}>
        <div><span className="acct-label">Carried over</span><b>{cycle ? num(cycle.carriedOver) : '—'}</b></div>
        <div><span className="acct-label">Added</span><b>{cycle ? signed(cycle.added) : '—'}</b></div>
        <div><span className="acct-label">Spent</span><b>{cycle ? signed(-cycle.spent) : '—'}</b></div>
        <div><span className="acct-label">Refunded</span><b>{cycle ? signed(cycle.refunded) : '—'}</b></div>
        <div className="tot"><span className="acct-label">Left now</span><b>{data ? num(data.balance) : '—'}</b></div>
      </div>

      <section className="card" aria-labelledby="spend-head">
        <div className="card-head acct-card-head">
          <h3 id="spend-head">Spent this cycle</h3>
          <span className="acct-note">{since ? `${since} – today` : ' '}</span>
        </div>
        <div className="card-body">
          {!cycle ? <Skeleton h={10} w="100%" />
            : spentTotal === 0 ? <p className="acct-note">Nothing spent yet this cycle.</p>
            : (
              <>
                <div className="acct-sbar" role="img" aria-label={cycle.byCategory.map((c) => `${c.category} ${c.credits}`).join(', ')}>
                  {cycle.byCategory.map((c, i) => (
                    <i key={c.category} style={{ flex: `${c.credits} 1 0`, background: SWATCH[i % SWATCH.length], animationDelay: `${i * 40}ms` }} />
                  ))}
                </div>
                <div className="acct-legend">
                  {cycle.byCategory.map((c, i) => (
                    <span key={c.category}><i style={{ background: SWATCH[i % SWATCH.length] }} />{c.category} <b className="mono">{num(c.credits)}</b></span>
                  ))}
                  <span>Total <b className="mono">{num(spentTotal)}</b></span>
                </div>
              </>
            )}
        </div>
      </section>

      <section className="card" aria-labelledby="activity-head">
        <div className="card-head acct-card-head">
          <h3 id="activity-head">Activity</h3>
          <div className="row acct-filters" role="group" aria-label="Filter activity">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
        </div>
        {isLoading && <div className="card-body"><Skeleton h={14} w="70%" /><Skeleton h={14} w="50%" style={{ marginTop: 10 }} /></div>}
        {!isLoading && rows.length === 0 && (
          <Empty icon="chart" title="No credit activity yet">Every caption, image and video you make shows up here with its cost.</Empty>
        )}
        {days.map((d) => {
          const lines = d.lines.filter((l) => filter === 'all' || l.tone === filter);
          if (!lines.length) return null;
          return (
            <div key={d.day}>
              <div className="acct-day"><span>{dayLabel(d.day)}</span><span className="mono">{signed(d.net)}</span></div>
              {lines.map((l) => (
                <div key={l.id} className="acct-lrow">
                  <div>
                    {l.title}{l.count > 1 && ` ×${l.count}`}
                    {l.detail && <small>{l.detail}</small>}
                  </div>
                  <span className={`mono${l.credits > 0 ? ' pos' : ''}`}>{signed(l.credits)}</span>
                </div>
              ))}
            </div>
          );
        })}
        {rows.length > 0 && filter !== 'all' && !days.some((d) => d.lines.some((l) => l.tone === filter)) && (
          <p className="acct-note card-body">Nothing like that in what’s loaded. Load older to look further back.</p>
        )}
        <div className="acct-card-foot">
          <span>{rows.length ? `${num(rows.length)} entries loaded` : ' '}</span>
          <span className="acct-cancel">
            <Button size="sm" busy={loading} disabled={!hasMore} reason="That’s everything" onClick={loadOlder}>
              {loading ? 'Loading…' : 'Load older'}
            </Button>
          </span>
        </div>
      </section>
    </div>
  );
}
