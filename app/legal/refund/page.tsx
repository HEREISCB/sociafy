// Refund & Cancellation Policy stub — required by Razorpay for verification.
// Reflects the cancel/refund behavior implemented in the billing flow.

export const metadata = {
  title: 'Refund & Cancellation Policy · Sociafy',
};

const COMPANY = 'GNIX SEMICONDUCTORS PRIVATE LIMITED';
const SUPPORT_EMAIL = 'support@sociafy.co'; // replace with verified support address
const LAST_UPDATED = '2026-05-23';

export default function RefundPolicyPage() {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px', fontFamily: 'var(--font-geist-sans)', lineHeight: 1.6 }}>
      <p style={{ marginBottom: 24 }}>
        <a href="/" style={{ color: 'var(--ink-3)', fontSize: 13, textDecoration: 'none' }}>&larr; Back to site</a>
      </p>
      <header style={{ marginBottom: 32, borderBottom: '1px solid var(--line)', paddingBottom: 16 }}>
        <h1 style={{ marginBottom: 8 }}>Refund &amp; Cancellation Policy</h1>
        <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: 0 }}>
          Applies to Sociafy subscriptions and credit top-ups sold by {COMPANY}.
        </p>
        <p style={{ color: 'var(--ink-3)', fontSize: 13, marginTop: 8 }}>Last updated: {LAST_UPDATED}</p>
      </header>

      <p style={{ background: '#fff8eb', border: '1px solid #f0d68a', padding: '12px 16px', borderRadius: 8, color: '#6b4408', fontSize: 13 }}>
        <strong>Draft notice:</strong> this document is a placeholder pending review by legal counsel. The policy described reflects current product behavior; the wording should be reviewed before going live.
      </p>

      <h2>1. Cancelling your subscription</h2>
      <p>
        You can cancel your subscription at any time from the <a href="/billing">Billing page</a> in your Sociafy account. Cancellation takes effect at the end of your current billing cycle. You retain access to the credits already granted for that cycle until the cycle ends; no further charges are made after that.
      </p>

      <h2>2. Subscription refunds</h2>
      <p>
        Subscription fees are non-refundable for the current billing cycle. We do not pro-rate refunds for partially used months. If you cancel, you keep the service through the end of the period you have already paid for, and we do not bill you for any subsequent period.
      </p>

      <h2>3. Top-up credits</h2>
      <p>
        One-time top-up purchases are non-refundable once the credits have been added to your account. Top-up credits do not expire while your account is active.
      </p>

      <h2>4. Tier upgrades and downgrades</h2>
      <p>
        Upgrading mid-cycle charges a prorated difference for the remaining days at the higher tier; the full upgraded credit allocation is granted immediately. Downgrades take effect at the next billing cycle; no refund is issued for the difference and the current tier&apos;s credits remain usable until the cycle ends.
      </p>

      <h2>5. Exceptional refunds</h2>
      <p>
        If you believe you were charged in error (duplicate charge, billing system failure, wrong amount), email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> within 30 days of the charge with your account email and the transaction ID. We will investigate and, if the claim is valid, refund the disputed amount to the original payment method within 7–10 business days.
      </p>

      <h2>6. Failed generations</h2>
      <p>
        If our AI providers fail to generate the content you requested, the credits deducted for that specific request are automatically refunded to your account balance (see the credit ledger on the Billing page).
      </p>

      <h2>7. Contact</h2>
      <p>
        For any refund or cancellation question:<br />
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </main>
  );
}
