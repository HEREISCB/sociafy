// Serves the repo's docs/api.md in-app so a customer never gets handed a GitHub
// URL. Read at module scope on purpose: the page takes no request-time input, so
// Next prerenders it at build and the file is never touched at runtime.
//
// Rendered by ./markdown rather than a markdown dependency — the doc uses seven
// constructs and none of them are worth a package. That renderer emits React
// elements, never HTML strings, so every scrap of doc text is escaped by React.

import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';
import { renderMarkdown } from './markdown';

export const metadata = { title: 'API reference · Sociafy' };

// The whole file is indented four spaces; strip it or every line is a code block.
const REFERENCE = fs
  .readFileSync(path.join(process.cwd(), 'docs/api.md'), 'utf8')
  .replace(/^ {4}/gm, '');

// Scoped to .md-doc so nothing here leaks into the app shell. Lives here rather
// than in globals.css because this is the only page that renders markdown.
const CSS = `
.md-doc { color: var(--ink-2); font-size: 14px; line-height: 1.7; }
.md-doc h1 { font-size: 27px; font-weight: 500; letter-spacing: -0.025em; color: var(--ink); margin: 0 0 14px; }
/* Every ## in this doc is preceded by a --- rule, so the heading carries no
   border of its own — two lines in a row reads as a mistake. */
.md-doc h2 { font-size: 20px; font-weight: 600; letter-spacing: -0.015em; color: var(--ink); margin: 30px 0 10px; }
.md-doc h3 { font-size: 15px; font-weight: 600; color: var(--ink); margin: 26px 0 8px; }
.md-doc h4, .md-doc h5, .md-doc h6 { font-size: 13.5px; font-weight: 600; color: var(--ink); margin: 20px 0 6px; }
.md-doc p { margin: 0 0 14px; }
.md-doc ul { margin: 0 0 14px; padding-left: 20px; }
.md-doc li { margin-bottom: 7px; }
.md-doc hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
.md-doc strong { color: var(--ink); font-weight: 600; }
.md-doc a { color: var(--accent-ink); text-decoration: underline; }
.md-doc code {
  font-size: 0.88em;
  background: var(--bg-sunk);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  overflow-wrap: anywhere;
}
.md-doc .code-block { margin: 0 0 16px; }
.md-doc .code-block pre { white-space: pre; }
/* A wide table must scroll inside itself, not push the page sideways. */
.md-scroll { overflow-x: auto; margin-bottom: 16px; -webkit-overflow-scrolling: touch; }
.md-doc .dev-table { min-width: 520px; }
.md-doc .dev-table code { background: none; border: 0; padding: 0; }
.md-doc .dev-table td:first-child { white-space: normal; }
@media (max-width: 720px) {
  .md-doc { font-size: 13.5px; }
  .md-doc h1 { font-size: 23px; }
  .md-doc h2 { font-size: 18px; }
}
`;

export default function ApiReferencePage() {
  return (
    <main className="doc-page">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <p style={{ marginBottom: 20 }}>
        <Link href="/developers" style={{ color: 'var(--ink-3)', fontSize: 13, textDecoration: 'none' }}>
          &larr; Back to Developers
        </Link>
      </p>
      <article className="md-doc">{renderMarkdown(REFERENCE)}</article>
    </main>
  );
}
