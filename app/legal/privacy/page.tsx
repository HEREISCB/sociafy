// Privacy policy. Replace the body with reviewed legal copy before going live.
// The legal entity name and contact details must remain visible for
// payment-gateway verification.

import { COMPANY, COMPANY_ADDRESS, LegalShell } from '../../../components/site-chrome';

export const metadata = {
  title: 'Privacy Policy · Sociafy',
  alternates: { canonical: '/legal/privacy' },
};

const SUPPORT_EMAIL = 'support@sociafy.app'; // replace with verified support address
const LAST_UPDATED = '2026-09-24';

const TOC = [
  { id: 'who-we-are', label: '1. Who we are' },
  { id: 'what-we-collect', label: '2. What we collect' },
  { id: 'how-we-use-it', label: '3. How we use it' },
  { id: 'who-we-share-it-with', label: '4. Who we share it with' },
  { id: 'data-retention', label: '5. Data retention' },
  { id: 'your-rights', label: '6. Your rights' },
  { id: 'security', label: '7. Security' },
  { id: 'changes', label: '8. Changes' },
  { id: 'contact', label: '9. Contact' }
];

export default function PrivacyPolicyPage() {
  return (
    <LegalShell
      page="privacy"
      title="Privacy Policy"
      intro={<>{COMPANY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the Sociafy product available at sociafy.app.</>}
      updated={LAST_UPDATED}
      toc={TOC}
      summary={[
        "We keep your account details, the tokens for accounts you connect, what you create, and basic logs needed to run the service.",
        "We don’t sell your data, and we don’t use your content to train models that serve other users.",
        "Free tools keep your prompt, the result, a cookie ID and a hashed IP; unclaimed results are deleted after 30 days. Email support@sociafy.app to get or delete your data.",
      ]}
    >
      <h2 id="who-we-are">1. Who we are</h2>
      <p>
        Sociafy is operated by <strong>{COMPANY}</strong>, a company incorporated under the laws of India. For any privacy-related question, write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2 id="what-we-collect">2. What we collect</h2>
      <ul>
        <li><strong>Account data:</strong> name, email, and authentication tokens via our identity provider (Clerk).</li>
        <li><strong>Connected social accounts:</strong> OAuth tokens for the platforms you choose to connect (X, LinkedIn, Instagram, Facebook, TikTok, YouTube). We never store your platform passwords.</li>
        <li><strong>Content you create:</strong> drafts, scheduled posts, generated media, and the prompts you submit to our AI features.</li>
        <li><strong>Billing data:</strong> handled by our payment processor (Razorpay). We store only a customer reference and subscription/payment IDs; we do not store card numbers.</li>
        <li><strong>Usage telemetry:</strong> basic logs needed to operate the service (request paths, response codes, error traces).</li>
        <li><strong>Free tools (no account):</strong> when you use our free generators (for example /try-image, /try-video and the /free-* tools) without signing in, we keep the prompt you enter, the result, a random ID in a cookie (<code>sfy_try</code>, one year), and a one-way salted hash of your IP address. We use these only to enforce the daily free limit, to hand your result to your account if you sign up, and to prevent abuse. We never store your raw IP address for this. We may also use Cloudflare Turnstile to check that a request comes from a person, not a bot.</li>
      </ul>

      <h2 id="how-we-use-it">3. How we use it</h2>
      <p>
        To provide the Sociafy service: generating drafts in your voice, scheduling posts, publishing to your connected accounts, billing you, supporting you, and improving the product. We do not sell your personal data, and we do not use your content to train models that serve other users.
      </p>

      <h2 id="who-we-share-it-with">4. Who we share it with</h2>
      <ul>
        <li><strong>AI providers</strong> (OpenAI, PiAPI): prompts and intermediate generations needed to fulfill your requests. Subject to their respective privacy terms.</li>
        <li><strong>Social platforms:</strong> only the content you explicitly publish.</li>
        <li><strong>Razorpay</strong> (payments): billing identifiers and the subscription/transaction metadata required for processing.</li>
        <li><strong>Infrastructure providers:</strong> Amazon Web Services (hosting), Cloudflare (network, bot protection and R2 media storage), Supabase (database), Clerk (authentication).</li>
      </ul>

      <h2 id="data-retention">5. Data retention</h2>
      <p>
        Account and billing data is retained for the lifetime of your subscription plus a reasonable period for legal and accounting obligations. Generated assets and drafts are retained until you delete them. Free-tool results that are not claimed by an account, along with their cookie ID and IP hash, are deleted after 30 days. You can request deletion of your account at any time by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2 id="your-rights">6. Your rights</h2>
      <p>
        Depending on your jurisdiction you may have rights to access, correct, export, or delete your data. Send requests to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will respond within a reasonable time.
      </p>

      <h2 id="security">7. Security</h2>
      <p>
        We use industry-standard transport encryption (TLS), encrypted storage at rest, and least-privilege access controls. No system is perfectly secure; please report suspected vulnerabilities to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2 id="changes">8. Changes</h2>
      <p>
        We will update the &ldquo;Last updated&rdquo; date when we change this policy. Material changes will be communicated by email.
      </p>

      <h2 id="contact">9. Contact</h2>
      <p>
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a><br />
        Registered office: {COMPANY_ADDRESS}
      </p>
    </LegalShell>
  );
}
