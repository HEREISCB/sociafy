const PLACEHOLDER_RX = /^(placeholder|todo|changeme|change-me|your-.+-here|xxx+)$/i;
const required = (key: string): string | null => {
  const v = process.env[key];
  if (!v || v.length === 0) return null;
  if (PLACEHOLDER_RX.test(v.trim())) return null;
  return v;
};

export const env = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  internalSecret: process.env.INTERNAL_API_SECRET || 'dev-secret-change-me',
  // No cronSecret here on purpose. A default made the check fail OPEN when the
  // var was unset. Cron routes read process.env.CRON_SECRET via checkCronAuth
  // (lib/api.ts), which refuses to run without a real secret.

  clerk: {
    publishableKey: required('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'),
    secretKey: required('CLERK_SECRET_KEY'),
  },

  database: {
    url: required('DATABASE_URL'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },

  // TwitterAPI.io — third-party pay-as-you-go X/Twitter READ API. The
  // reputation shield uses it to fetch brand mentions without an official
  // X API subscription. Replies still go out via official X OAuth (platforms.x).
  twitterApiIo: {
    apiKey: required('TWITTERAPI_IO_KEY'),
  },

  r2: {
    accountId: required('R2_ACCOUNT_ID'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET_NAME'),
    publicBase: process.env.NEXT_PUBLIC_R2_PUBLIC_URL_BASE || '',
  },

  platforms: {
    x: {
      clientId: required('X_CLIENT_ID'),
      clientSecret: required('X_CLIENT_SECRET'),
    },
    linkedin: {
      clientId: required('LINKEDIN_CLIENT_ID'),
      clientSecret: required('LINKEDIN_CLIENT_SECRET'),
    },
    meta: {
      appId: required('META_APP_ID'),
      appSecret: required('META_APP_SECRET'),
      // Facebook Login for Business: a Configuration ID bundles permissions + assets.
      // When set, OAuth uses config_id instead of scope=...
      configId: required('META_CONFIG_ID'),
      webhookVerifyToken: required('META_WEBHOOK_VERIFY_TOKEN'),
    },
    // Instagram Business Login product — Meta assigns this a SEPARATE app ID
    // and app secret distinct from the parent Meta/Facebook app. Required for
    // the direct Instagram OAuth flow and Instagram-side webhook signatures.
    instagram: {
      appId: required('INSTAGRAM_APP_ID'),
      appSecret: required('INSTAGRAM_APP_SECRET'),
    },
    tiktok: {
      clientKey: required('TIKTOK_CLIENT_KEY'),
      clientSecret: required('TIKTOK_CLIENT_SECRET'),
    },
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
    },
    reddit: {
      clientId: required('REDDIT_CLIENT_ID'),
      clientSecret: required('REDDIT_CLIENT_SECRET'),
    },
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    priceStarter: required('STRIPE_PRICE_STARTER'),
    pricePro: required('STRIPE_PRICE_PRO'),
    priceBusiness: required('STRIPE_PRICE_BUSINESS'),
  },

  razorpay: {
    keyId: required('RAZORPAY_KEY_ID'),
    keySecret: required('RAZORPAY_KEY_SECRET'),
    webhookSecret: required('RAZORPAY_WEBHOOK_SECRET'),
    planStarter: required('RAZORPAY_PLAN_STARTER'),
    planPro: required('RAZORPAY_PLAN_PRO'),
    planBusiness: required('RAZORPAY_PLAN_BUSINESS'),
  },

  // Zoho Books — raises the GST invoice for every captured payment.
  // Auth is the self-client refresh-token grant: the refresh token never
  // expires, so there is no interactive re-consent to babysit.
  zoho: {
    clientId: required('ZOHO_CLIENT_ID'),
    clientSecret: required('ZOHO_CLIENT_SECRET'),
    refreshToken: required('ZOHO_REFRESH_TOKEN'),
    organizationId: required('ZOHO_ORGANIZATION_ID'),
    /** Data-centre suffix: 'in' (India), 'com', 'eu', 'com.au', 'jp', 'ca', 'sa'. */
    region: process.env.ZOHO_REGION || 'in',
    /** Tax id of the 18% GST rate in Books. Without it Zoho raises a ₹0-tax invoice. */
    gstTaxId: required('ZOHO_GST_TAX_ID'),
    /** Deposit-to account for recording the payment. Unset → invoice stays unpaid. */
    depositAccountId: required('ZOHO_DEPOSIT_ACCOUNT_ID'),
    /** SAC for online information & database access / SaaS. */
    sacCode: process.env.ZOHO_SAC_CODE || '998314',
  },
} as const;

export const isStubMode = {
  clerk: () => !env.clerk.publishableKey || !env.clerk.secretKey,
  database: () => !env.database.url,
  // AI: OpenAI preferred, Groq accepted, Anthropic legacy fallback.
  ai: () => !process.env.OPENAI_API_KEY && !process.env.GROQ_API_KEY && !env.anthropic.apiKey,
  r2: () => !env.r2.accountId || !env.r2.bucket,
  stripe: () => !env.stripe.secretKey,
  razorpay: () => !env.razorpay.keyId || !env.razorpay.keySecret,
  zoho: () =>
    !env.zoho.clientId ||
    !env.zoho.clientSecret ||
    !env.zoho.refreshToken ||
    !env.zoho.organizationId,
  platform: (p: 'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'reddit'): boolean => {
    switch (p) {
      case 'x': return !env.platforms.x.clientId;
      case 'linkedin': return !env.platforms.linkedin.clientId;
      case 'instagram': return !env.platforms.instagram.appId;
      case 'facebook': return !env.platforms.meta.appId;
      case 'tiktok': return !env.platforms.tiktok.clientKey;
      case 'youtube': return !env.platforms.google.clientId;
      case 'reddit': return !env.platforms.reddit.clientId;
    }
  },
};

/** Returns the country to use when the geo header is absent. Reads
 *  DEV_FORCE_COUNTRY (e.g. 'IN' / 'US'). Returns null if unset. */
export function devForcedCountry(): string | null {
  return process.env.DEV_FORCE_COUNTRY?.toUpperCase() ?? null;
}

/**
 * The visitor's country per the edge, or null when nothing geolocated them.
 *
 * `CF-IPCountry` first: production is Cloudflare → nginx → Next and that is the
 * only header on the wire (etc/nginx/sites-available/sociafy.conf). The Vercel
 * header is the fallback for preview deploys.
 *
 * DISPLAY ONLY. nginx copies through whatever the client sent, so treat this as
 * a hint — never as identity, and never persist it.
 */
export function geoCountry(headers: { get(name: string): string | null }): string | null {
  // Cloudflare sends XX when it cannot geolocate and T1 for Tor — both mean
  // "unknown", and passing them on would read as "not India" instead of letting
  // the client fall back to its own timezone guess.
  const cf = headers.get('cf-ipcountry')?.toUpperCase();
  if (cf && cf !== 'XX' && cf !== 'T1') return cf;
  return headers.get('x-vercel-ip-country')?.toUpperCase()
    ?? devForcedCountry()
    ?? null;
}
