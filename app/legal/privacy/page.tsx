// Privacy policy. Replace the body with reviewed legal copy before going live.
// The legal entity name and contact details must remain visible for
// payment-gateway verification.

import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy · Sociafy',
};

const COMPANY = 'GNIX SEMICONDUCTORS PRIVATE LIMITED';
const SUPPORT_EMAIL = 'support@sociafy.app'; // replace with verified support address
const LAST_UPDATED = '2026-05-23';

export default function PrivacyPolicyPage() {
  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '48px 24px', fontFamily: 'var(--font-geist-sans)', lineHeight: 1.6 }}>
      <p style={{ marginBottom: 24 }}>
        <Link href="/" style={{ color: 'var(--ink-3)', fontSize: 13, textDecoration: 'none' }}>&larr; Back to site</Link>
      </p>
      <header style={{ marginBottom: 32, borderBottom: '1px solid var(--line)', paddingBottom: 16 }}>
        <h1 style={{ marginBottom: 8 }}>Privacy Policy</h1>
        <p style={{ color: 'var(--ink-3)', fontSize: 14, margin: 0 }}>
          {COMPANY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the Sociafy product available at sociafy.app.
        </p>
        <p style={{ color: 'var(--ink-3)', fontSize: 13, marginTop: 8 }}>Last updated: {LAST_UPDATED}</p>
      </header>

      <h2>1. Who we are</h2>
      <p>
        Sociafy is operated by <strong>{COMPANY}</strong>, a company incorporated under the laws of India. For any privacy-related question, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li><strong>Account data</strong> — name, email, and authentication tokens via our identity provider (Clerk).</li>
        <li><strong>Connected social accounts</strong> — OAuth tokens for the platforms you choose to connect (X, LinkedIn, Instagram, Facebook, TikTok, YouTube). We never store your platform passwords.</li>
        <li><strong>Content you create</strong> — drafts, scheduled posts, generated media, and the prompts you submit to our AI features.</li>
        <li><strong>Billing data</strong> — handled by our payment processor (Razorpay). We store only a customer reference and subscription/payment IDs; we do not store card numbers.</li>
        <li><strong>Usage telemetry</strong> — basic logs needed to operate the service (request paths, response codes, error traces).</li>
      </ul>

      <h2>3. How we use it</h2>
      <p>
        To provide the Sociafy service: generating drafts in your voice, scheduling posts, publishing to your connected accounts, billing you, supporting you, and improving the product. We do not sell your personal data, and we do not use your content to train models that serve other users.
      </p>

      <h2>4. Who we share it with</h2>
      <ul>
        <li><strong>AI providers</strong> (OpenAI, PiAPI) — prompts and intermediate generations needed to fulfill your requests. Subject to their respective privacy terms.</li>
        <li><strong>Social platforms</strong> — only the content you explicitly publish.</li>
        <li><strong>Razorpay</strong> (payments) — billing identifiers and the subscription/transaction metadata required for processing.</li>
        <li><strong>Infrastructure providers</strong> — Vercel (hosting), Cloudflare R2 (media storage), Supabase (database), Clerk (authentication).</li>
      </ul>

      <h2>5. Data retention</h2>
      <p>
        Account and billing data is retained for the lifetime of your subscription plus a reasonable period for legal and accounting obligations. Generated assets and drafts are retained until you delete them. You can request deletion of your account at any time by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Depending on your jurisdiction you may have rights to access, correct, export, or delete your data. Send requests to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will respond within a reasonable time.
      </p>

      <h2>7. Security</h2>
      <p>
        We use industry-standard transport encryption (TLS), encrypted storage at rest, and least-privilege access controls. No system is perfectly secure; please report suspected vulnerabilities to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>8. Changes</h2>
      <p>
        We will update the &ldquo;Last updated&rdquo; date when we change this policy. Material changes will be communicated by email.
      </p>

      <h2>9. Contact</h2>
      <p>
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a><br />
        Registered office: <em>[registered address pending]</em>
      </p>
    </main>
  );
}
