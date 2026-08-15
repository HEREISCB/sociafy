import React from 'react';

/**
 * The smallest markdown renderer that covers docs/api.md: headings, paragraphs,
 * rules, bullet lists, fenced code, pipe tables, and inline code / bold / em /
 * links. Deliberately not a dependency — this is the only markdown in the app.
 *
 * It emits React elements, never HTML strings, so there is no
 * dangerouslySetInnerHTML anywhere on the path from the file to the page and
 * React escapes every character of doc text on the way out. Keep it that way.
 */

// Bold is lazy rather than [^*]+ so `**a *b* c**` still closes on the outer
// pair; the doc has three of those and a strict class leaves loose asterisks on
// the page. Bold is tried before em at any given position, so it wins.
// Built fresh per call rather than hoisted: inline() recurses, and a shared /g
// regex would have the inner call trash the outer one's lastIndex.
const inlineRe = () => /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*([^*\n]+)\*/g;

export function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = inlineRe();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `i${m.index}`;
    // Bold and em recurse: the doc opens with **`POST /api/v1/images` has two
    // modes**, and a code span nested in bold still has to render as code.
    // A code span never recurses — its content is literal by definition.
    if (m[1] !== undefined) out.push(<code className="mono" key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<a href={m[3]} key={k}>{m[2]}</a>);
    else if (m[4] !== undefined) out.push(<strong key={k}>{inline(m[4])}</strong>);
    else out.push(<em key={k}>{inline(m[5])}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Split a table row on unescaped pipes. `a \| b` is one cell reading "a | b". */
const cells = (row: string) =>
  row
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

const isFence = (l: string) => l.startsWith('```');
const isRule = (l: string) => /^-{3,}$/.test(l.trim());
const isBullet = (l: string) => /^[-*] /.test(l);
const isHeading = (l: string) => /^#{1,6} /.test(l);
const isTable = (l: string) => l.startsWith('|');
const startsBlock = (l: string) =>
  !l.trim() || isFence(l) || isRule(l) || isBullet(l) || isHeading(l) || isTable(l);

export function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  const key = () => `b${i}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (isFence(line)) {
      const k = key();
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(
        <div className="code-block" key={k}>
          <pre>{body.join('\n')}</pre>
        </div>,
      );
      continue;
    }

    if (isHeading(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${Math.min(level, 6)}` as 'h1';
      out.push(<Tag key={key()}>{inline(line.slice(level + 1))}</Tag>);
      i++;
      continue;
    }

    if (isRule(line)) { out.push(<hr key={key()} />); i++; continue; }

    // A table is a pipe row whose successor is the |---|---| separator.
    if (isTable(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
      const k = key();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTable(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        // Wide tables scroll inside this box so the page never scrolls sideways.
        <div className="md-scroll" key={k}>
          <table className="dev-table">
            <thead>
              <tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (isBullet(line)) {
      const k = key();
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        let item = lines[i++].slice(2);
        // Wrapped continuation lines are indented under their bullet.
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(item);
      }
      out.push(<ul key={k}>{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ul>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    out.push(<p key={key()}>{inline(para.join(' '))}</p>);
  }

  return out;
}
