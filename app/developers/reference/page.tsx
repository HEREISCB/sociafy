// Serves the repo's docs/api.md in-app so a customer never gets handed a GitHub
// URL. Read at module scope on purpose: the page takes no request-time input, so
// Next prerenders it at build and the file is never touched at runtime. Rendered
// as-is rather than parsed — markdown in a monospace column is readable, and a
// renderer would be a dependency for one page.

import fs from 'node:fs';
import path from 'node:path';
import Link from 'next/link';

export const metadata = { title: 'API reference · Sociafy' };

const REFERENCE = fs.readFileSync(path.join(process.cwd(), 'docs/api.md'), 'utf8');

export default function ApiReferencePage() {
  return (
    <main className="doc-page">
      <p style={{ marginBottom: 20 }}>
        <Link href="/developers" style={{ color: 'var(--ink-3)', fontSize: 13, textDecoration: 'none' }}>
          &larr; Back to Developers
        </Link>
      </p>
      <pre className="doc-md">{REFERENCE}</pre>
    </main>
  );
}
