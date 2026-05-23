# Razorpay Setup — One-time

1. **Create three Plans** in Razorpay Dashboard → Subscriptions → Plans:
   - "Sociafy Starter (INR)" · ₹2,999 · Monthly · 30 days.
   - "Sociafy Pro (INR)" · ₹7,999 · Monthly · 30 days.
   - "Sociafy Business (INR)" · ₹29,999 · Monthly · 30 days.

   Copy each plan's `plan_id` (looks like `plan_OabcXyz`) into:
   - `RAZORPAY_PLAN_STARTER`
   - `RAZORPAY_PLAN_PRO`
   - `RAZORPAY_PLAN_BUSINESS`

2. **Webhook endpoint**: Settings → Webhooks → Add new endpoint.
   - URL: `https://<your-host>/api/razorpay/webhook`
   - Active events:
     - `subscription.activated`
     - `subscription.charged`
     - `subscription.updated`
     - `subscription.cancelled`
     - `subscription.completed`
     - `subscription.halted`
     - `subscription.paused`
     - `payment.captured`
   - Generate a secret → copy into `RAZORPAY_WEBHOOK_SECRET`.

3. **API keys**: Settings → API Keys → Generate.
   - Copy `key_id` into both `RAZORPAY_KEY_ID` and `NEXT_PUBLIC_RAZORPAY_KEY_ID`.
   - Copy `key_secret` into `RAZORPAY_KEY_SECRET`.

4. **Test mode first**: do steps 1–3 in Test Mode. Use test cards from
   [razorpay.com/docs/payments/payments/test-card-details](https://razorpay.com/docs/payments/payments/test-card-details)
   to verify the whole flow. Flip to Live Mode keys once the manual test
   matrix in the design spec passes end-to-end.

5. **Local dev**: set `DEV_FORCE_COUNTRY=IN` in `.env.local` so the
   country detector returns India without needing a Vercel deployment.

6. **SQL migration**: paste `drizzle/0007_billing_providers.sql` into the
   Supabase SQL Editor (Database → SQL Editor → New query) and run.
   Idempotent: safe to re-run.
