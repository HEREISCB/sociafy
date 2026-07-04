/**
 * lib/shield/notify.ts
 *
 * Crisis alerting for the reputation shield. Fires when a scan surfaces new
 * crisis-level mentions, so teams hear about it immediately (the market's
 * "notify → act" loop) instead of having to open the dashboard.
 *
 * Channels:
 *  - Incoming webhook (Slack- AND Discord-compatible: we send both `text` and
 *    `content` keys; each platform reads its own and ignores the other).
 *  - Email via Resend's REST API (only when RESEND_API_KEY is set — no SDK dep).
 *
 * Never throws — alerting is best-effort and must not break a scan.
 */

export interface CrisisAlertMention {
  title: string;
  url: string;
  severity: number;
  source: string;
}

export interface CrisisAlert {
  brand: string;
  mentions: CrisisAlertMention[];
}

function buildText(alert: CrisisAlert): string {
  const n = alert.mentions.length;
  const header = `🚨 Reputation Shield — ${n} new crisis mention${n === 1 ? '' : 's'} for "${alert.brand}"`;
  const lines = alert.mentions
    .slice(0, 5)
    .map(m => `• [${m.severity}/10 · ${m.source}] ${m.title.slice(0, 140)}${m.url ? `\n  ${m.url}` : ''}`);
  return [header, '', ...lines].join('\n');
}

async function postWebhook(url: string, alert: CrisisAlert): Promise<void> {
  const text = buildText(alert);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` → Slack, `content` → Discord. Harmless extra key on each.
      body: JSON.stringify({ text, content: text }),
    });
  } catch {
    /* best-effort */
  }
}

async function sendEmail(to: string, alert: CrisisAlert): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const from = process.env.RESEND_FROM || 'Sociafy Shield <onboarding@resend.dev>';
  const n = alert.mentions.length;
  const rows = alert.mentions
    .slice(0, 10)
    .map(
      m =>
        `<li><strong>[${m.severity}/10 · ${m.source}]</strong> ${escapeHtml(m.title)}${
          m.url ? ` — <a href="${escapeHtml(m.url)}">view</a>` : ''
        }</li>`,
    )
    .join('');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: `🚨 ${n} new crisis mention${n === 1 ? '' : 's'} for "${alert.brand}"`,
        html: `<h2>Reputation Shield alert</h2><p>${n} new crisis mention${n === 1 ? '' : 's'} for <strong>${escapeHtml(alert.brand)}</strong>:</p><ul>${rows}</ul>`,
      }),
    });
  } catch {
    /* best-effort */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Send a crisis alert across whichever channels the user has configured. */
export async function sendCrisisAlert(opts: {
  webhookUrl?: string | null;
  email?: string | null;
  alert: CrisisAlert;
}): Promise<void> {
  if (opts.alert.mentions.length === 0) return;
  const tasks: Promise<void>[] = [];
  if (opts.webhookUrl) tasks.push(postWebhook(opts.webhookUrl, opts.alert));
  if (opts.email) tasks.push(sendEmail(opts.email, opts.alert));
  await Promise.allSettled(tasks);
}
