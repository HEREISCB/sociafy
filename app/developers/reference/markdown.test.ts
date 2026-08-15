import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { renderMarkdown } from './markdown';

const html = (md: string) =>
  renderToStaticMarkup(React.createElement('div', null, renderMarkdown(md)));

describe('the docs/api.md renderer', () => {
  it('escapes HTML in the source — this page renders a file from the repo', () => {
    const out = html('A <script>alert(1)</script> and an & and a "quote".');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('escapes HTML inside code spans and fenced blocks too', () => {
    expect(html('`<img onerror=x>`')).not.toContain('<img');
    expect(html('```\n<script>bad()</script>\n```')).not.toContain('<script>');
  });

  it('renders headings, rules and paragraphs', () => {
    const out = html('# Title\n\ntext\n\n---\n\n## Two\n\n### Three');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<h2>Two</h2>');
    expect(out).toContain('<h3>Three</h3>');
    expect(out).toContain('<hr/>');
    expect(out).toContain('<p>text</p>');
  });

  it('renders inline code, bold, em and links', () => {
    const out = html('a `code` **bold** *em* [text](https://x.test)');
    expect(out).toContain('<code class="mono">code</code>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>em</em>');
    expect(out).toContain('<a href="https://x.test">text</a>');
  });

  it('nests inline markup inside bold — the doc opens with a code span in bold', () => {
    expect(html('**`POST /images` has two modes.**'))
      .toContain('<strong><code class="mono">POST /images</code> has two modes.</strong>');
    // **a *b* c** must close on the outer pair, not leave stray asterisks.
    const out = html('**A sweeper for *synchronous* images.**');
    expect(out).toContain('<em>synchronous</em>');
    expect(out).not.toContain('*');
  });

  it('renders fenced code verbatim, without parsing markdown inside it', () => {
    const out = html('```bash\n# 30-120s is typical\necho **not bold**\n```');
    expect(out).toContain('<div class="code-block"><pre># 30-120s is typical\necho **not bold**</pre></div>');
  });

  it('renders tables, honouring escaped pipes inside a cell', () => {
    const out = html('| A | B |\n|---|---|\n| `x` \\| `y` | two |');
    expect(out).toContain('<table class="dev-table">');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td><code class="mono">x</code> | <code class="mono">y</code></td>');
    // Wide tables get their own scroll box so the page never scrolls sideways.
    expect(out).toContain('<div class="md-scroll">');
  });

  it('joins a bullet\'s wrapped continuation lines into one item', () => {
    const out = html('- first line\n  wrapped on\n- second\n');
    expect(out).toContain('<li>first line wrapped on</li>');
    expect(out).toContain('<li>second</li>');
  });

  it('renders the real docs/api.md with no markdown markers left on the page', () => {
    const src = fs
      .readFileSync(path.resolve(__dirname, '../../../docs/api.md'), 'utf8')
      .replace(/^ {4}/gm, '');
    const out = html(src);
    // The whole doc, not one <pre> of raw text.
    expect(out).not.toContain('doc-md');
    expect((out.match(/<h2>/g) ?? []).length).toBe(12);
    expect((out.match(/<table/g) ?? []).length).toBe(12);
    // Strip code and pre, then nothing markdown-ish may remain in the prose.
    const prose = out
      .replace(/<pre>[\s\S]*?<\/pre>/g, '')
      .replace(/<code[^>]*>[\s\S]*?<\/code>/g, '')
      .replace(/<[^>]+>/g, '');
    expect(prose).not.toMatch(/\*/);
    expect(prose).not.toMatch(/`/);
    expect(prose).not.toMatch(/(^|\n)#{1,6} /);
  });
});
