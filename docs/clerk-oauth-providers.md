# Clerk OAuth Providers — Setup

Sign-in / sign-up are rendered by Clerk's `<SignIn />` / `<SignUp />` widgets.
The OAuth providers that appear (Google, Microsoft, LinkedIn, Apple, etc.) are
controlled entirely by what's enabled in the Clerk dashboard — not by code.

This document is the punch-list for getting our sign-in flow to feel as
multi-option as Buffer / Linear / Notion.

## Status today (test instance)

Test instance host: `first-locust-2.clerk.accounts.dev`

| Provider | Status | Notes |
|---|---|---|
| Email + password | ✅ | Always on |
| Google | ✅ | Enabled (verified in the sign-in widget) |
| LinkedIn (OIDC) | ❌ | **Enable this — see steps below** |
| Microsoft | ❌ | Recommended for B2B users |
| Apple | ❌ | Recommended for iOS visitors |
| GitHub | ❌ | Nice-to-have for dev personas |

## How to enable LinkedIn (OIDC)

1. Visit **https://www.linkedin.com/developers/apps** → **Create app**
   - App name: `Sociafy` (or use the existing Meta-style app)
   - Logo: 100×100 with a transparent background
   - Privacy URL: `https://sociafy.app/legal/privacy`
2. **Products** tab → request **Sign In with LinkedIn using OpenID Connect**
   - Auto-approved for most accounts within minutes
3. **Auth** tab → add redirect URL:
   `https://clerk.sociafy.app/v1/oauth_callback`
   (Get the exact URL from Clerk Dashboard → Social Connections → LinkedIn
    when you start the next step — Clerk shows it)
4. Copy **Client ID** and **Client Secret** from LinkedIn
5. Clerk Dashboard → **User & Authentication → Social Connections**
   → toggle **LinkedIn** ON
   → paste Client ID + Secret
   → save
6. Done — LinkedIn appears in the sign-in widget automatically. No code change.

## How to enable Microsoft

Same flow as LinkedIn but via Azure AD:

1. **portal.azure.com** → **App registrations** → **New registration**
2. Redirect URI = `https://clerk.sociafy.app/v1/oauth_callback`
3. Copy **Application (client) ID** and create a client secret
4. Clerk Dashboard → enable Microsoft, paste the values

## How to enable Apple

Apple is finicky (requires a paid Developer account, a Services ID, and a
key). Worth it for iOS/Mac users but **defer this until launch**.

1. **developer.apple.com** → Identifiers → New → Services ID
2. Add `signin.sociafy.app` as the Return URL (Clerk gives you the exact
   value)
3. Create a key under Keys → Sign In with Apple
4. Clerk Dashboard → enable Apple → upload the key and Service ID

## After enabling new providers

- No deploy needed. Clerk picks them up live.
- Sign-in widget will show new buttons stacked above the email field.
- For B2B users, Google + Microsoft + LinkedIn is the canonical trio. Add
  GitHub if dev-tool branding matters.

## When you go live

When you flip Clerk from test (`pk_test_*`) to live (`pk_live_*`):
- Repeat steps 1-5 for the **live** Clerk instance host (different
  `clerk.accounts.dev` host → different redirect URI).
- LinkedIn / Microsoft / Apple all need separate live-mode credentials.
- The test-mode OAuth apps keep working for the test Clerk — leave them.

## Why not control providers in code?

Clerk treats provider config as an instance-level setting. Their SDK
auto-renders whatever's enabled. Trying to pin specific providers in
`<SignIn />` JSX would just override what's already configured — same
result, more places to forget to update.

The widget appearance / heading / subhead IS controlled in code
(`app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx`).
That's where copy and styling live.
