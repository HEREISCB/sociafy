const required = (key: string): string | null => {
  const v = process.env[key];
  return v && v.length > 0 ? v : null;
};

export const env = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  internalSecret: process.env.INTERNAL_API_SECRET || 'dev-secret-change-me',
  cronSecret: process.env.CRON_SECRET || 'dev-cron-secret-change-me',

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
} as const;

export const isStubMode = {
  clerk: () => !env.clerk.publishableKey || !env.clerk.secretKey,
  database: () => !env.database.url,
  // AI runs on OpenAI now. Anthropic key kept as legacy fallback only.
  ai: () => !process.env.OPENAI_API_KEY && !env.anthropic.apiKey,
  r2: () => !env.r2.accountId || !env.r2.bucket,
  stripe: () => !env.stripe.secretKey,
  razorpay: () => !env.razorpay.keyId || !env.razorpay.keySecret,
  platform: (p: 'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'): boolean => {
    switch (p) {
      case 'x': return !env.platforms.x.clientId;
      case 'linkedin': return !env.platforms.linkedin.clientId;
      case 'instagram': return !env.platforms.instagram.appId;
      case 'facebook': return !env.platforms.meta.appId;
      case 'tiktok': return !env.platforms.tiktok.clientKey;
      case 'youtube': return !env.platforms.google.clientId;
    }
  },
};

/** Returns the country to use when the Vercel geo header is absent. Reads
 *  DEV_FORCE_COUNTRY (e.g. 'IN' / 'US'). Returns null if unset. */
export function devForcedCountry(): string | null {
  return process.env.DEV_FORCE_COUNTRY?.toUpperCase() ?? null;
}
