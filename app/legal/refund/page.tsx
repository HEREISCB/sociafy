// Refund & Cancellation Policy — required by Razorpay for verification.
// Reflects the cancel/refund behavior implemented in the billing flow.

import { COMPANY, LegalShell } from '../../../components/site-chrome';

export const metadata = {
  title: 'Refund & Cancellation Policy · Sociafy',
  alternates: { canonical: '/legal/refund' },
};

const SUPPORT_EMAIL = 'support@sociafy.app';
const LAST_UPDATED = '2026-05-23';

const TOC = [
  { id: 'cancelling-your-subscription', label: '1. Cancelling your subscription' },
  { id: 'subscription-refunds', label: '2. Subscription refunds' },
  { id: 'top-up-credits', label: '3. Top-up credits' },
  { id: 'tier-upgrades-and-downgrades', label: '4. Tier upgrades and downgrades' },
  { id: 'exceptional-refunds', label: '5. Exceptional refunds' },
  { id: 'failed-generations', label: '6. Failed generations' },
  { id: 'contact', label: '7. Contact' }
];

export default function RefundPolicyPage() {
  return (
    <LegalShell
      page="refund"
      title="Refund & Cancellation Policy"
      intro={<>Applies to Sociafy subscriptions and credit top-ups sold by {COMPANY}.</>}
      updated={LAST_UPDATED}
      toc={TOC}
      summary={[
        "Cancel anytime from Account, Billing & usage. It ends with your current billing cycle.",
        "The current month is not refunded or pro-rated. You keep access until it ends.",
        "Top-up credits do not expire while your account is active, and are not refundable once added. Credits for a failed generation come back automatically.",
      ]}
    >
      <h2 id="cancelling-your-subscription">1. Cancelling your subscription</h2>
      <p>
        You can cancel your subscription at any time from <a href="/account/billing">Account → Billing &amp; usage</a> in your Sociafy account. Cancellation takes effect at the end of your current billing cycle. You retain access to the credits already granted for that cycle until the cycle ends; no further charges are made after that.
      </p>

      <h2 id="subscription-refunds">2. Subscription refunds</h2>
      <p>
        Subscription fees are non-refundable for the current billing cycle. We do not pro-rate refunds for partially used months. If you cancel, you keep the service through the end of the period you have already paid for, and we do not bill you for any subsequent period.
      </p>

      <h2 id="top-up-credits">3. Top-up credits</h2>
      <p>
        One-time top-up purchases are non-refundable once the credits have been added to your account. Top-up credits do not expire while your account is active.
      </p>

      <h2 id="tier-upgrades-and-downgrades">4. Tier upgrades and downgrades</h2>
      <p>
        Upgrading mid-cycle charges a prorated difference for the remaining days at the higher tier; the full upgraded credit allocation is granted immediately. Downgrades take effect at the next billing cycle; no refund is issued for the difference and the current tier&apos;s credits remain usable until the cycle ends.
      </p>

      <h2 id="exceptional-refunds">5. Exceptional refunds</h2>
      <p>
        If you believe you were charged in error (duplicate charge, billing system failure, wrong amount), email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> within 30 days of the charge with your account email and the transaction ID. We will investigate and, if the claim is valid, refund the disputed amount to the original payment method within 7–10 business days.
      </p>

      <h2 id="failed-generations">6. Failed generations</h2>
      <p>
        If our AI providers fail to generate the content you requested, the credits deducted for that specific request are automatically refunded to your account balance (see the credit ledger in Account → Billing &amp; usage).
      </p>

      <h2 id="contact">7. Contact</h2>
      <p>
        For any refund or cancellation question:<br />
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </p>
    </LegalShell>
  );
}
