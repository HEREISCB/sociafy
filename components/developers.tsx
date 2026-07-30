'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import { DEFAULT_CAP } from './api-keys';
import { CREDIT_PRICES } from '../lib/credits/pricing';

/** Public base URL for v1. Derived so a staging or self-hosted deploy shows its
 *  own origin in the copy-paste snippets instead of production's. */
const BASE = `${process.env.NEXT_PUBLIC_APP_URL || 'https://sociafy.app'}/api/v1`;

/** Platform-wide 24h ceiling across all API customers. Mirrors GLOBAL_DAILY_CAP
 *  in lib/api-key.ts, which reads API_DAILY_CREDIT_CAP — a server env var, so it
 *  cannot be imported here. Stated as the default, which is what it is. */
const GLOBAL_CAP = 50_000;

/** Copy button + scrollable code, matching the reveal-once key panel's clipboard
 *  pattern. No reset timer: the tick is a receipt, and the snippet never changes. */
const Code: React.FC<{ children: string }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        type="button"
        className="btn sm code-copy"
        onClick={async () => {
          await navigator.clipboard.writeText(children).catch(() => {});
          setCopied(true);
        }}
      >
        <Icon name={copied ? 'check' : 'link'} size={12} /> {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  );
};

const Endpoint: React.FC<{ method: string; path: string; blurb: string; children: React.ReactNode }> = ({
  method, path, blurb, children,
}) => (
  <div className="dev-endpoint">
    <div className="dev-endpoint-head mono">
      <span className={`dev-method ${method.toLowerCase()}`}>{method}</span> {path}
    </div>
    <div className="sub">{blurb}</div>
    {children}
  </div>
);

const P = CREDIT_PRICES;

export const DeveloperDocs: React.FC = () => (
  <>
    <section className="usage-card" style={{ marginTop: 28 }}>
      <h3>Quickstart</h3>
      <div className="sub" style={{ marginBottom: 6 }}>
        Four endpoints, one Bearer key, metered in credits from the same balance the
        dashboard spends. You do not need an account with any generation provider.
        <br />
        Base URL <code className="mono">{BASE}</code> · <strong>server-to-server only</strong> —
        no endpoint sends CORS headers, and the key is a secret that spends money.
      </div>

      <ol className="dev-steps">
        <li>Create a key above and copy it — the plaintext is shown exactly once.</li>
        <li>Send it as <code className="mono">Authorization: Bearer sfy_live_…</code> on every request.</li>
        <li>
          Confirm it is alive with <code className="mono">GET /me</code>, which costs no credits and
          is never rate-limited:
        </li>
      </ol>

      <Code>{`export SOCIAFY_API_KEY="sfy_live_paste_your_key_here"

curl -sS ${BASE}/me \\
  -H "Authorization: Bearer $SOCIAFY_API_KEY"`}</Code>

      <div className="sub" style={{ marginTop: 10 }}>A working key answers <code className="mono">200</code> with:</div>
      <Code>{`{
  "balance": 4820,
  "key_prefix": "sfy_live_a1b2c3",
  "credits_charged_today": 540,
  "daily_cap": 2000,
  "daily_cap_remaining": 1460
}`}</Code>
      <div className="sub" style={{ marginTop: 10 }}>
        <code className="mono">401</code> instead? The header is missing, malformed, or the key was
        revoked. Keys are hashed at rest and cannot be recovered — make a new one.
      </div>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>Endpoints</h3>
      <div className="sub" style={{ marginBottom: 4 }}>
        Every path below is relative to <code className="mono">{BASE}</code>. Unknown request fields
        are rejected with <code className="mono">400</code> rather than ignored, so a typo in{' '}
        <code className="mono">quality</code> never silently bills you for a default you did not pick.
      </div>

      <Endpoint method="GET" path="/me" blurb="Key health and remaining spend. Free, uncapped, never rate-limited — it keeps working while you are over your cap, which is exactly when you need it.">
        <div className="sub">
          Returns <code className="mono">balance</code>, <code className="mono">key_prefix</code>,{' '}
          <code className="mono">credits_charged_today</code>, <code className="mono">daily_cap</code>,{' '}
          <code className="mono">daily_cap_remaining</code>. <code className="mono">credits_charged_today</code>{' '}
          is gross — refunds are not netted out of it, though <code className="mono">balance</code> does
          reflect them.
        </div>
      </Endpoint>

      <Endpoint method="POST" path="/videos" blurb="Submit a text-to-video generation. Returns 202 immediately — generation takes 30–120s, so you poll rather than hold a connection open.">
        <Code>{`curl -X POST ${BASE}/videos \\
  -H "Authorization: Bearer $SOCIAFY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-8891-clip-1" \\
  -d '{
    "prompt": "slow dolly-in on a neon ramen bar at night, steam rising",
    "duration_sec": 8,
    "quality": "720p",
    "aspect": "9:16",
    "fast": false
  }'`}</Code>
        <Code>{`{
  "id": "8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901",
  "status": "pending",
  "credits_charged": ${P.video_8s_720p_quality},
  "duration_sec": 8,
  "quality": "720p",
  "aspect": "9:16",
  "poll_url": "/api/v1/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901"
}`}</Code>
        <table className="dev-table">
          <thead>
            <tr><th>Field</th><th>Allowed</th><th>Default</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">prompt</td><td>string, 2–2000 chars. Used verbatim — there is no prompt rewriting on the API.</td><td>required</td></tr>
            <tr><td className="mono">duration_sec</td><td>integer 4–15, priced pro-rata</td><td className="mono">8</td></tr>
            <tr><td className="mono">quality</td><td className="mono">480p · 720p · 1080p</td><td className="mono">720p</td></tr>
            <tr><td className="mono">aspect</td><td className="mono">9:16 · 1:1 · 16:9</td><td className="mono">9:16</td></tr>
            <tr><td className="mono">fast</td><td>boolean — cheaper and quicker, slightly lower fidelity. Ignored at 1080p, which has no fast tier.</td><td className="mono">false</td></tr>
            <tr><td className="mono">gen_mode</td><td className="mono">&quot;text&quot;</td><td className="mono">&quot;text&quot;</td></tr>
          </tbody>
        </table>
        <div className="sub" style={{ marginTop: 10 }}>
          Image-to-video and reference/character modes are not in v1 — we cannot price them
          correctly, and would rather refuse than guess with your money. There is no{' '}
          <code className="mono">count</code>: one request is one job, one charge, one id.
        </div>
      </Endpoint>

      <Endpoint method="GET" path="/videos/{id}" blurb="Poll every 5–10s until status is completed or failed. Polling is free and not rate-limited; please stay under one request per second.">
        <Code>{`curl -sS ${BASE}/videos/8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901 \\
  -H "Authorization: Bearer $SOCIAFY_API_KEY"`}</Code>
        <Code>{`{
  "id": "8f2c1d6e-4a71-4b0e-9a3c-77c1e5b2d901",
  "status": "completed",
  "video_url": "https://<media-host>/users/user_2ab.../vid-175353-9f3c.mp4",
  "credits_charged": ${P.video_8s_720p_quality},
  "error": null
}`}</Code>
        <div className="sub" style={{ marginTop: 10 }}>
          <code className="mono">status</code> is <code className="mono">pending</code>,{' '}
          <code className="mono">completed</code> or <code className="mono">failed</code>; while pending,{' '}
          <code className="mono">video_url</code> and <code className="mono">error</code> are both null.
          A failed job reports its reason in <code className="mono">error</code> and refunds its credits.
          Jobs complete and are stored even if you stop polling, so a crashed worker loses nothing.
          An id belonging to another account returns <code className="mono">404</code>, same as one that
          never existed.
        </div>
      </Endpoint>

      <Endpoint method="POST" path="/images" blurb="Synchronous — 66–78s measured at medium quality, up to ~2 minutes with reference images, returned as 200. The request is held open for up to 300 seconds, so set your client timeout to at least 180 — a 60s default fails every time.">
        <Code>{`curl -X POST ${BASE}/images \\
  -H "Authorization: Bearer $SOCIAFY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-8891-hero" \\
  -d '{
    "prompt": "overhead flat-lay of a matcha latte on warm oak, soft window light",
    "size": "1024x1024",
    "quality": "medium"
  }'`}</Code>
        <Code>{`{
  "id": "c11e8a4f-2d33-4c9a-8b71-0a5e6f2c4d18",
  "image_url": "https://<media-host>/users/user_2ab.../api-175353-7b1a.png",
  "credits_charged": ${P.image_medium_1024}
}`}</Code>
        <table className="dev-table">
          <thead>
            <tr><th>Field</th><th>Allowed</th><th>Default</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">prompt</td><td>string, 2–2000 chars</td><td>required</td></tr>
            <tr><td className="mono">size</td><td className="mono">1024x1024 · 1536x1024 · 1024x1536</td><td className="mono">1024x1024</td></tr>
            <tr><td className="mono">quality</td><td className="mono">low · medium · high</td><td className="mono">medium</td></tr>
            <tr>
              <td className="mono">reference_images</td>
              <td>
                1–4 <strong>https</strong> URLs of photos to work from —{' '}
                <code className="mono">png</code> · <code className="mono">jpeg</code> ·{' '}
                <code className="mono">webp</code>, under 5 MB each, 16 megapixels in total, no
                redirects, no private hosts. Surcharged per megapixel (see below).
              </td>
              <td>omitted</td>
            </tr>
          </tbody>
        </table>
        <div className="sub" style={{ marginTop: 10 }}>
          Send photos of the real product and the output follows them instead of only your words —
          several angles of one item beat a single shot. <strong>Likeness is guided, not
          guaranteed:</strong> you get a faithful rendition of the form, materials and finish, not a
          pixel-accurate copy, so do not rely on it to reproduce a hallmark, a serial number or
          engraved text. Anything wrong with a URL comes back as its own{' '}
          <code className="mono">400</code> (<code className="mono">reference_url_rejected</code>,{' '}
          <code className="mono">reference_unfetchable</code>,{' '}
          <code className="mono">reference_type_unsupported</code>,{' '}
          <code className="mono">reference_too_large</code>,{' '}
          <code className="mono">reference_dimensions_unreadable</code>,{' '}
          <code className="mono">reference_pixels_exceeded</code>) with the offending{' '}
          <code className="mono">reference_url</code> — never as{' '}
          <code className="mono">prompt_rejected</code>, and never charged.
        </div>
      </Endpoint>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>The video flow, in full</h3>
      <div className="sub" style={{ marginBottom: 6 }}>
        This is the part integrators get wrong. Video is <strong>asynchronous</strong>: the{' '}
        <code className="mono">POST</code> only books and charges the job.
      </div>
      <ol className="dev-steps">
        <li><code className="mono">POST /videos</code> → <code className="mono">202</code> with an{' '}
          <code className="mono">id</code> and a <code className="mono">poll_url</code>. Credits are
          charged here, at submission.</li>
        <li><code className="mono">GET</code> the <code className="mono">poll_url</code> every 5–10s
          while <code className="mono">status</code> is <code className="mono">pending</code>.</li>
        <li><code className="mono">completed</code> → take <code className="mono">video_url</code>.{' '}
          <code className="mono">failed</code> → read <code className="mono">error</code>; credits were
          refunded and you need a <strong>new</strong> <code className="mono">Idempotency-Key</code> to
          try again, because a failed job keeps its old one.</li>
      </ol>
      <Code>{`#!/usr/bin/env bash
set -euo pipefail
IDEM="campaign-2026-07-hero-01"   # stable, derived from your own data

id=$(curl -sS -X POST ${BASE}/videos \\
  -H "Authorization: Bearer $SOCIAFY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $IDEM" \\
  -d '{"prompt":"aerial push over a foggy pine ridge at sunrise","quality":"720p","aspect":"16:9"}' \\
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

for _ in $(seq 1 60); do
  body=$(curl -sS "${BASE}/videos/$id" -H "Authorization: Bearer $SOCIAFY_API_KEY")
  status=$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
  [ "$status" = "pending" ] || { printf '%s\\n' "$body"; exit 0; }
  sleep 5
done
echo "still pending after 5 minutes" >&2; exit 1`}</Code>
      <div className="sub" style={{ marginTop: 10 }}>
        Send an <code className="mono">Idempotency-Key</code> (8–200 printable ASCII, no spaces) on
        every <code className="mono">POST</code>. It is optional, but without one a retry is a second
        charge. Replaying a key returns the original result — same id, same charge, no second
        generation. Derive it from something already unique on your side, never a timestamp.
      </div>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>Credit costs</h3>
      <div className="sub" style={{ marginBottom: 4 }}>
        Charged at submission. Polling, <code className="mono">GET /me</code>, and any request
        rejected with <code className="mono">400</code>/<code className="mono">401</code>/
        <code className="mono">404</code>/<code className="mono">429</code> are free.
      </div>

      <div className="dev-cost-label mono">Video · 4–12 s <span>(pro-rata from the 8 s price: 6 s at 720p quality = {P.video_8s_720p_quality} × 6/8 = {Math.round(P.video_8s_720p_quality * 6 / 8)})</span></div>
      <table className="dev-table">
        <thead><tr><th>Quality</th><th className="mono">fast: true</th><th className="mono">fast: false</th></tr></thead>
        <tbody>
          <tr><td className="mono">480p</td><td className="mono">{P.video_8s_480p_fast}</td><td className="mono">{P.video_8s_480p_quality}</td></tr>
          <tr><td className="mono">720p</td><td className="mono">{P.video_8s_720p_fast}</td><td className="mono">{P.video_8s_720p_quality}</td></tr>
          <tr><td className="mono">1080p</td><td className="mono">—</td><td className="mono">{P.video_8s_1080p_quality}</td></tr>
        </tbody>
      </table>

      <div className="dev-cost-label mono">Video · 13–15 s <span>(pro-rata from the 15 s price; no fast tier)</span></div>
      <table className="dev-table">
        <thead><tr><th>Quality</th><th>Credits</th></tr></thead>
        <tbody>
          <tr><td className="mono">480p</td><td className="mono">{P.video_15s_480p_quality}</td></tr>
          <tr><td className="mono">720p</td><td className="mono">{P.video_15s_720p_quality}</td></tr>
          <tr><td className="mono">1080p</td><td className="mono">{P.video_15s_1080p_quality}</td></tr>
        </tbody>
      </table>

      <div className="dev-cost-label mono">Images</div>
      <table className="dev-table">
        <thead><tr><th>Quality</th><th>Square 1024×1024</th><th>Portrait / landscape</th></tr></thead>
        <tbody>
          <tr><td className="mono">low</td><td className="mono">{P.image_low_1024}</td><td className="mono">{P.image_low_1024}</td></tr>
          <tr><td className="mono">medium</td><td className="mono">{P.image_medium_1024}</td><td className="mono">{P.image_medium_portrait}</td></tr>
          <tr><td className="mono">high</td><td className="mono">{P.image_high_1024}</td><td className="mono">{P.image_high_portrait}</td></tr>
        </tbody>
      </table>

      <div className="dev-cost-label mono">
        Image reference input <span>(added to the price above)</span>
      </div>
      <table className="dev-table">
        <thead><tr><th>Add-on</th><th>Credits</th></tr></thead>
        <tbody>
          <tr>
            <td className="mono">reference_images</td>
            <td className="mono">{P.image_reference_mp} per megapixel of input</td>
          </tr>
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 6 }}>
        Megapixels are summed across every reference, read from the files themselves, and rounded up
        to a whole credit: one 1024×1024 reference on a medium square image is{' '}
        {P.image_medium_1024} + {Math.ceil(1.048576 * P.image_reference_mp)} ={' '}
        {P.image_medium_1024 + Math.ceil(1.048576 * P.image_reference_mp)} credits, four of them are{' '}
        {P.image_medium_1024 + Math.ceil(4 * 1.048576 * P.image_reference_mp)}, and one 4000×3000
        photo is {P.image_medium_1024 + 12 * P.image_reference_mp}. The provider bills us ~1,024
        input tokens per megapixel, so a big photo genuinely costs more than the image it guides —
        downscale to about 1024 px on the long edge and this stays small. Requests without{' '}
        <code className="mono">reference_images</code> are priced exactly as before.
      </div>

      <div className="sub" style={{ marginTop: 12 }}>
        <strong>Failed generations refund automatically</strong>, to the credit — a provider failure, a
        result we could not store, an unacknowledged submission, or a job still unfinished after 2
        hours. You never have to ask. One honest caveat: image refunds run inline in the failing
        request, so if that process dies mid-flight nothing retries it — image refunds are best-effort
        in v1, video refunds are guaranteed by a background reconciler.
      </div>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>Limits</h3>
      <table className="dev-table">
        <thead><tr><th>Limit</th><th>Value</th><th>What to do</th></tr></thead>
        <tbody>
          <tr>
            <td>Credit cap, per key</td>
            <td>Rolling 24 h, default {DEFAULT_CAP.toLocaleString()} credits</td>
            <td>Edit the cap inline in the panel above — no need to rotate the key.</td>
          </tr>
          <tr>
            <td>Burst, per key</td>
            <td><code className="mono">POST</code>: 3 immediately, then 1 per 100 s</td>
            <td>Videos and images have separate buckets. Honour <code className="mono">Retry-After</code>.</td>
          </tr>
          <tr>
            <td>Reads</td>
            <td>Not limited, not capped</td>
            <td>Poll a job or call <code className="mono">/me</code> freely — a GET never charges.</td>
          </tr>
          <tr>
            <td>Platform ceiling</td>
            <td>{GLOBAL_CAP.toLocaleString()} credits / 24 h across all API customers (default)</td>
            <td>Surfaces as <code className="mono">429 api_capacity_exceeded</code>. Not about your key — retry later.</td>
          </tr>
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 12 }}>
        The credit cap is a <em>spend</em> limit, not a request limit, and it is checked before a
        request is priced rather than against its price — so the request that crosses the line goes
        through in full and <strong>one job can overshoot the cap by its own cost</strong>. Leave one
        maximum-priced job of headroom if that matters to you. The burst limiter is in-process, so on a
        multi-instance deploy the real ceiling is somewhere between 3 and 3 × instances: treat 3 as the
        guaranteed floor, not a quota to ride.
      </div>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>Errors</h3>
      <div className="sub" style={{ marginBottom: 4 }}>
        Every error is JSON with a stable <code className="mono">error</code> code and a human{' '}
        <code className="mono">message</code>. Match on <code className="mono">error</code> — the codes
        are stable, the prose is not. The ones you will actually hit:
      </div>
      <table className="dev-table">
        <thead><tr><th>Status</th><th className="mono">error</th><th>What to do</th></tr></thead>
        <tbody>
          <tr><td className="mono">400</td><td className="mono">invalid_request</td><td>Body failed validation; <code className="mono">issues[]</code> names up to 5 fields. Nothing was charged.</td></tr>
          <tr><td className="mono">401</td><td className="mono">unauthorized</td><td>Key missing, malformed, unknown, or revoked. Check the header, then the key list above.</td></tr>
          <tr><td className="mono">402</td><td className="mono">insufficient_credits</td><td>Carries <code className="mono">balance</code> and <code className="mono">needed</code>. Top up on <Link href="/billing">Billing</Link> and retry.</td></tr>
          <tr><td className="mono">409</td><td className="mono">request_in_progress</td><td>An earlier request with this <code className="mono">Idempotency-Key</code> is still running. Retry the same key in a few seconds.</td></tr>
          <tr><td className="mono">429</td><td className="mono">rate_limited</td><td>Burst limit. Sleep <code className="mono">retry_after_sec</code> (also in <code className="mono">Retry-After</code>).</td></tr>
          <tr><td className="mono">429</td><td className="mono">daily_cap_exceeded</td><td>This key hit its 24 h credit cap; carries <code className="mono">spent</code> and <code className="mono">cap</code>. Raise it above. No <code className="mono">Retry-After</code> — back off in minutes.</td></tr>
          <tr><td className="mono">502</td><td className="mono">upstream_error</td><td>Generation failed or could not be delivered. Credits were refunded; safe to retry — with a new <code className="mono">Idempotency-Key</code> for videos.</td></tr>
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 10 }}>
        Six more codes (<code className="mono">prompt_rejected</code>,{' '}
        <code className="mono">configuration_error</code>, <code className="mono">not_found</code> and
        friends) plus the failed-video reason codes are in the full reference below.
      </div>
    </section>

    <section className="usage-card" style={{ marginTop: 20 }}>
      <h3>Full reference</h3>
      <div className="sub" style={{ marginBottom: 12 }}>
        Everything above is the short version. The complete v1 reference covers idempotency
        semantics end to end, output-URL retention, the refund rules, versioning guarantees, and
        what is deliberately not in v1.
      </div>
      <Link href="/developers/reference" className="btn primary">
        <Icon name="book" size={13} /> Read the full API reference
      </Link>
    </section>
  </>
);
