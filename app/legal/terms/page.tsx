// Terms of Service. Replace the body with reviewed legal copy before going live.

import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service · Sociafy',
};

const COMPANY = 'GNIX SEMICONDUCTORS PRIVATE LIMITED';
const SUPPORT_EMAIL = 'support@sociafy.app';
const LAST_UPDATED = '2026-05-23';

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px', fontFamily: 'var(--font-geist-sans)', lineHeight: 1.6 }}>
      <p style={{ marginBottom: 24 }}>
        <Link href="/" style={{ color: 'var(--ink-3)', fontSize: 13, textDecoration: 'none' }}>&larr; Back to site</Link>
      </p>
      <header style={{ marginBottom: 32, borderBottom: '1px solid var(--line)', paddingBottom: 16 }}>
        <h1 style={{ marginBottom: 8 }}>Terms of Service</h1>
        <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: 0 }}>
          Agreement between you and {COMPANY} for use of the Sociafy product.
        </p>
        <p style={{ color: 'var(--ink-3)', fontSize: 13, marginTop: 8 }}>Last updated: {LAST_UPDATED}</p>
      </header>

      <h2>1. The service</h2>
      <p>
        Sociafy (&ldquo;the Service&rdquo;) is an AI-assisted social-media management product operated by <strong>{COMPANY}</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an account or accessing the Service you agree to these terms.
      </p>

      <h2>2. Eligibility &amp; account</h2>
      <p>
        You must be at least 18 years old and capable of entering a binding contract. You are responsible for keeping your account credentials secure and for all activity under your account.
      </p>

      <h2>3. Acceptable use</h2>
      <p>
        You agree not to: violate any law, infringe intellectual-property rights, post content that is illegal or hateful, spam, scrape the Service, attempt to bypass rate limits or quotas, or use the Service to generate harmful content (e.g. CSAM, malware, doxxing, targeted harassment).
      </p>

      <h2>4. Subscriptions, billing &amp; credits</h2>
      <p>
        Paid plans are billed monthly via our payment processor (Razorpay) in INR or your selected currency. Plans carry a monthly credit allocation; credits roll over for one month (two months on the Business tier). One-time top-up credits do not expire while your account is active. Pricing, credit allocations and per-action credit costs are listed on the Sociafy pricing page; we may change them with reasonable notice for future cycles.
      </p>

      <h2>5. Cancellations &amp; refunds</h2>
      <p>
        See our <a href="/legal/refund">Refund &amp; Cancellation Policy</a>.
      </p>

      <h2>6. Your content</h2>
      <p>
        You retain ownership of the content you submit and the content the Service generates on your behalf. You grant {COMPANY} a limited licence to process that content solely to provide the Service (storage, transmission to the platforms you choose to publish to, processing by AI providers).
      </p>

      <h2>7. AI output</h2>
      <p>
        Generated text, images, and video may contain inaccuracies, biases, or factual errors. You are responsible for reviewing all AI output before publishing it under your name or brand. The Service is not a substitute for professional advice.
      </p>

      <h2>8. Voice cloning &amp; avatars</h2>
      <p>
        Voice Twin lets you create a synthetic copy of a voice, and Avatar lets you generate talking-video from a face photo. When you create a Voice Twin you confirm, by checkbox and typed signature recorded with your account, that the audio is a recording of <strong>your own voice</strong> and that you have the full right to clone it. You agree not to use these features to impersonate any person, or to create deceptive, fraudulent, harassing, unlawful, or misleading content. You are solely and fully responsible for everything you create with a cloned voice or avatar. We retain a record of your consent and may suspend or terminate accounts, and cooperate with authorities, in cases of misuse.
      </p>

      <h2>9. Third-party services</h2>
      <p>
        The Service interoperates with third-party platforms (X, LinkedIn, Meta, TikTok, YouTube, Razorpay, OpenAI, PiAPI) and GPU infrastructure providers. Your use of those platforms is governed by their respective terms. We are not responsible for outages or policy changes on their side.
      </p>

      <h2>10. Disclaimers &amp; liability</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; without warranties of any kind to the maximum extent permitted by law. Our aggregate liability for any claim arising out of or relating to the Service is limited to the fees you paid to us in the twelve months preceding the claim.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may cancel your subscription at any time from the Billing page. We may suspend or terminate accounts that violate these terms. On termination, your credits expire and your data may be deleted after a reasonable grace period.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These terms are governed by the laws of India. Any dispute will be subject to the exclusive jurisdiction of the courts at the registered office of {COMPANY}.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these terms; material changes will be communicated by email. Continued use of the Service after the change date constitutes acceptance.
      </p>

      <h2>14. Contact</h2>
      <p>
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a><br />
        Registered office: <em>[registered address pending]</em>
      </p>
    </main>
  );
}
