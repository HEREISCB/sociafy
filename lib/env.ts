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
} as const;

export const isStubMode = {
  clerk: () => !env.clerk.publishableKey || !env.clerk.secretKey,
  database: () => !env.database.url,
  ai: () => !env.anthropic.apiKey,
  r2: () => !env.r2.accountId || !env.r2.bucket,
  platform: (p: 'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'): boolean => {
    switch (p) {
      case 'x': return !env.platforms.x.clientId;
      case 'linkedin': return !env.platforms.linkedin.clientId;
      case 'instagram':
      case 'facebook': return !env.platforms.meta.appId;
      case 'tiktok': return !env.platforms.tiktok.clientKey;
      case 'youtube': return !env.platforms.google.clientId;
    }
  },
};
