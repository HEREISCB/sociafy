import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripEmDashes, ON_SCREEN_TEXT_RULE } from './voice-rules';

describe('stripEmDashes', () => {
  it.each([
    ['clause, lowercase', 'We shipped it — and nobody noticed.', 'We shipped it, and nobody noticed.'],
    ['new sentence, capital', 'We shipped it — Nobody noticed.', 'We shipped it. Nobody noticed.'],
    ['word—word', 'Speed—not polish—wins.', 'Speed, not polish, wins.'],
    ['parenthetical pair', 'The tool — which costs $5 — is great.', 'The tool, which costs $5, is great.'],
    ['numeric range', 'Open 9—5, Mon to Fri.', 'Open 9–5, Mon to Fri.'],
    ['spaced range, money', 'Plans from $5 — $10.', 'Plans from $5–$10.'],
    ['year range', 'Revenue 2020 — 2024 doubled.', 'Revenue 2020–2024 doubled.'],
    ['line start', '— Ship daily\n— Learn weekly', '- Ship daily\n- Learn weekly'],
    ['line end before list', 'Here is what changed —\n1. Faster', 'Here is what changed:\n1. Faster'],
    ['end of text', 'And then —', 'And then.'],
    ['after punctuation', 'Really? — yes.', 'Really? yes.'],
    ['before punctuation', 'And so—.', 'And so.'],
    ['quote attribution', '"Ship it" — Steve', '"Ship it", Steve'],
    ['before an opening quote', 'He said — "no"', 'He said, "no"'],
    ['multiple dashes', 'Wait —— what', 'Wait, what'],
    ['URL untouched', 'Read https://x.com/a—b — it helps', 'Read https://x.com/a—b, it helps'],
    ['inline code untouched', 'Run `a — b` — then wait', 'Run `a — b`, then wait'],
    ['fenced code untouched', '```\nx — y\n```\nDone — ok', '```\nx — y\n```\nDone, ok'],
    ['en dash range left alone', '6–180 s', '6–180 s'],
    ['hyphen left alone', 'A well-known fact - really', 'A well-known fact - really'],
    ['emoji after dash', 'Big news — 🎉 we launched', 'Big news, 🎉 we launched'],
  ])('%s', (_, input, expected) => {
    expect(stripEmDashes(input)).toBe(expected);
  });

  it('returns text without em dashes unchanged (same string)', () => {
    const s = 'No dashes here. https://a.b/c';
    expect(stripEmDashes(s)).toBe(s);
    expect(stripEmDashes('')).toBe('');
  });

  it('is idempotent', () => {
    const once = stripEmDashes('A — b — C—d — 1—2');
    expect(stripEmDashes(once)).toBe(once);
    expect(once).not.toContain('—');
  });
});

describe('motion-ai worker guidance', () => {
  it.each(['motion-ai/scaffold/CLAUDE.md', 'motion-ai/footage-edit.md'])('%s carries the on-screen text rule verbatim', (f) => {
    expect(fs.readFileSync(path.join(process.cwd(), f), 'utf8')).toContain(ON_SCREEN_TEXT_RULE);
  });
});
