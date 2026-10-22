// Terms of Service. Replace the body with reviewed legal copy before going live.

import { COMPANY, COMPANY_ADDRESS, LegalShell } from '../../../components/site-chrome';

export const metadata = {
  title: 'Terms of Service · Sociafy',
  alternates: { canonical: '/legal/terms' },
};

const SUPPORT_EMAIL = 'support@sociafy.app';
const LAST_UPDATED = '2026-05-23';

const TOC = [
  { id: 'the-service', label: '1. The service' },
  { id: 'eligibility-account', label: '2. Eligibility & account' },
  { id: 'acceptable-use', label: '3. Acceptable use' },
  { id: 'subscriptions-billing-credits', label: '4. Subscriptions, billing & credits' },
  { id: 'cancellations-refunds', label: '5. Cancellations & refunds' },
  { id: 'your-content', label: '6. Your content' },
  { id: 'ai-output', label: '7. AI output' },
  { id: 'voice-cloning-avatars', label: '8. Voice cloning & avatars' },
  { id: 'third-party-services', label: '9. Third-party services' },
  { id: 'disclaimers-liability', label: '10. Disclaimers & liability' },
  { id: 'termination', label: '11. Termination' },
  { id: 'governing-law', label: '12. Governing law' },
  { id: 'changes', label: '13. Changes' },
  { id: 'contact', label: '14. Contact' }
];

export default function TermsPage() {
  return (
    <LegalShell
      page="terms"
      title="Terms of Service"
      intro={<>Agreement between you and {COMPANY} for use of the Sociafy product.</>}
      updated={LAST_UPDATED}
      toc={TOC}
      summary={[
        "You must be 18 or older, and you are responsible for activity on your account.",
        "Plans are billed monthly and come with credits. Cancel anytime; it takes effect at the end of the cycle.",
        "You own what you submit and what Sociafy makes for you. Review AI output before you publish it.",
      ]}
    >
      <h2 id="the-service">1. The service</h2>
      <p>
        Sociafy (&ldquo;the Service&rdquo;) is an AI-assisted social-media management product operated by <strong>{COMPANY}</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an account or accessing the Service you agree to these terms.
      </p>

      <h2 id="eligibility-account">2. Eligibility &amp; account</h2>
      <p>
        You must be at least 18 years old and capable of entering a binding contract. You are responsible for keeping your account credentials secure and for all activity under your account.
      </p>

      <h2 id="acceptable-use">3. Acceptable use</h2>
      <p>
        You agree not to: violate any law, infringe intellectual-property rights, post content that is illegal or hateful, spam, scrape the Service, attempt to bypass rate limits or quotas, or use the Service to generate harmful content (e.g. CSAM, malware, doxxing, targeted harassment).
      </p>

      <h2 id="subscriptions-billing-credits">4. Subscriptions, billing &amp; credits</h2>
      <p>
        Paid plans are billed monthly via our payment processor (Razorpay) in INR or your selected currency. Plans carry a monthly credit allocation; credits roll over for one month (two months on the Business tier). One-time top-up credits do not expire while your account is active. Pricing, credit allocations and per-action credit costs are listed on the Sociafy pricing page; we may change them with reasonable notice for future cycles.
      </p>

      <h2 id="cancellations-refunds">5. Cancellations &amp; refunds</h2>
      <p>
        See our <a href="/legal/refund">Refund &amp; Cancellation Policy</a>.
      </p>

      <h2 id="your-content">6. Your content</h2>
      <p>
        You retain ownership of the content you submit and the content the Service generates on your behalf. You grant {COMPANY} a limited licence to process that content solely to provide the Service (storage, transmission to the platforms you choose to publish to, processing by AI providers).
      </p>

      <h2 id="ai-output">7. AI output</h2>
      <p>
        Generated text, images, and video may contain inaccuracies, biases, or factual errors. You are responsible for reviewing all AI output before publishing it under your name or brand. The Service is not a substitute for professional advice.
      </p>

      <h2 id="voice-cloning-avatars">8. Voice cloning &amp; avatars</h2>
      <p>
        Voice Twin lets you create a synthetic copy of a voice, and Avatar lets you generate talking-video from a face photo. When you create a Voice Twin you confirm, by checkbox and typed signature recorded with your account, that the audio is a recording of <strong>your own voice</strong> and that you have the full right to clone it. You agree not to use these features to impersonate any person, or to create deceptive, fraudulent, harassing, unlawful, or misleading content. You are solely and fully responsible for everything you create with a cloned voice or avatar. We retain a record of your consent and may suspend or terminate accounts, and cooperate with authorities, in cases of misuse.
      </p>

      <h2 id="third-party-services">9. Third-party services</h2>
      <p>
        The Service interoperates with third-party platforms (X, LinkedIn, Meta, TikTok, YouTube, Razorpay, OpenAI, PiAPI) and GPU infrastructure providers. Your use of those platforms is governed by their respective terms. We are not responsible for outages or policy changes on their side.
      </p>

      <h2 id="disclaimers-liability">10. Disclaimers &amp; liability</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; without warranties of any kind to the maximum extent permitted by law. Our aggregate liability for any claim arising out of or relating to the Service is limited to the fees you paid to us in the twelve months preceding the claim.
      </p>

      <h2 id="termination">11. Termination</h2>
      <p>
        You may cancel your subscription at any time from Account → Billing &amp; usage. We may suspend or terminate accounts that violate these terms. On termination, your credits expire and your data may be deleted after a reasonable grace period.
      </p>

      <h2 id="governing-law">12. Governing law</h2>
      <p>
        These terms are governed by the laws of India. Any dispute will be subject to the exclusive jurisdiction of the courts at the registered office of {COMPANY}.
      </p>

      <h2 id="changes">13. Changes</h2>
      <p>
        We may update these terms; material changes will be communicated by email. Continued use of the Service after the change date constitutes acceptance.
      </p>

      <h2 id="contact">14. Contact</h2>
      <p>
        <strong>{COMPANY}</strong><br />
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a><br />
        Registered office: {COMPANY_ADDRESS}
      </p>
    </LegalShell>
  );
}
