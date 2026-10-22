'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '../../../../../components/icons';
import { Button, Empty, Skeleton } from '../../../../../components/ui';
import { useApi } from '../../../../../lib/ui/fetcher';
import { BillingDetailsFields, BillingDetailsSummary, useBillingDetails } from '../../../../../components/billing/billing-details';
import { inr, longDate } from '../../../../../components/billing/account-ui';

type InvoiceRow = {
  id: string;
  kind: 'subscription' | 'topup' | 'upgrade';
  status: 'pending' | 'issued' | 'failed';
  number: string | null;
  url: string | null;
  grossMinor: number;
  taxMinor: number;
  taxRatePct: number;
  description: string | null;
  createdAt: string;
};

const KIND_LABEL: Record<InvoiceRow['kind'], string> = { subscription: 'Plan', topup: 'Top-up', upgrade: 'Plan upgrade' };

export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesInner />
    </Suspense>
  );
}

function InvoicesInner() {
  const params = useSearchParams();
  const billing = useBillingDetails();
  const { data, isLoading } = useApi<{ invoices: InvoiceRow[] }>('/api/billing/invoices');
  // ?edit=1 from the top-up sheet's "Invoice to … Edit" opens the form.
  const [editing, setEditing] = useState(() => !!params.get('edit'));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (params.get('edit')) window.history.replaceState(null, '', '/account/invoices');
  }, [params]);

  const save = async () => {
    const err = await billing.save();
    setError(err);
    if (!err) { setEditing(false); setSaved(true); }
  };
  const invalid = billing.validate();
  const invoices = data?.invoices ?? [];

  return (
    <div className="acct-page">
      <section className="card" aria-labelledby="tax-head">
        <div className="card-head acct-card-head">
          <h3 id="tax-head">{editing ? 'Invoice details' : 'Invoices go to'}</h3>
          {!editing && saved && (
            <span className="acct-saved" role="status"><span className="acct-tick" aria-hidden="true"><Icon name="check" size={14} /></span>Saved. Your next invoice uses these details.</span>
          )}
          {editing
            ? <span className="acct-note">Used from your next payment</span>
            : <Button size="sm" disabled={!billing.loaded} onClick={() => { setEditing(true); setSaved(false); }}><Icon name="edit" size={12} /> Edit details</Button>}
        </div>
        {editing ? (
          <div className="card-body acct-swap">
            <BillingDetailsFields value={billing.value} set={billing.set} setAddress={billing.setAddress} />
            <div className="acct-form-acts">
              {error && <span className="field-error" role="alert">{error}</span>}
              <Button onClick={() => { billing.reset(); setEditing(false); setError(null); }} disabled={billing.saving}>Cancel</Button>
              <Button variant="primary" busy={billing.saving} disabled={!!invalid} reason={invalid ?? undefined} onClick={save}>
                {billing.saving ? 'Saving…' : 'Save details'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="card-body">
            {billing.loaded ? <BillingDetailsSummary value={billing.value} /> : <Skeleton h={48} w="100%" />}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="inv-head">
        <div className="card-head acct-card-head">
          <h3 id="inv-head">Invoices</h3>
          <span className="acct-note">One for every payment · amounts include GST</span>
        </div>
        {isLoading && <div className="card-body"><Skeleton h={14} w="60%" /></div>}
        {!isLoading && invoices.length === 0 && (
          <Empty icon="book" title="No invoices yet">A GST invoice is issued for every payment, and it shows up here.</Empty>
        )}
        {invoices.map((inv) => (
          <div key={inv.id} className="acct-irow">
            <div>
              {inv.description ?? KIND_LABEL[inv.kind]}
              <small>{longDate(inv.createdAt)}{inv.number && <> · <span className="mono">{inv.number}</span></>}</small>
            </div>
            <div className="acct-amt">
              <span className="mono">{inr(inv.grossMinor)}</span>
              <small>{inv.taxRatePct === 0 ? 'No GST (export)' : `incl. ${inr(inv.taxMinor)} GST`}</small>
            </div>
            <div className="acct-act">
              {inv.url ? (
                <a className="btn sm" href={inv.url} target="_blank" rel="noreferrer"><Icon name="download" size={12} /> Download PDF</a>
              ) : (
                // Money moved and credits landed; only the document is late.
                <span className="acct-note">{inv.status === 'failed' ? 'Paid · PDF delayed, we’re retrying' : 'Paid · PDF usually ready in a few minutes'}</span>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
