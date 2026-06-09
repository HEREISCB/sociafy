import Link from 'next/link';

export const metadata = {
  title: 'Not found · Sociafy',
};

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        textAlign: 'center',
        background: 'var(--bg, #fbf8f3)',
        color: 'var(--ink, #18181b)',
        fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
      }}
    >
      <Link
        href="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 32,
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <span
          style={{
            display: 'inline-grid',
            placeItems: 'center',
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'oklch(0.72 0.18 55)',
            color: 'white',
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          S
        </span>
        <span style={{ fontWeight: 600, fontSize: 18 }}>
          sociafy<span style={{ color: 'oklch(0.72 0.18 55)' }}>.</span>
        </span>
      </Link>

      <p
        style={{
          fontFamily: 'var(--font-geist-mono), monospace',
          fontSize: 12,
          letterSpacing: '0.05em',
          color: '#71717a',
          margin: 0,
        }}
      >
        404 · NOT FOUND
      </p>
      <h1 style={{ fontSize: 32, fontWeight: 600, margin: '12px 0 8px', maxWidth: 520 }}>
        That page wandered off.
      </h1>
      <p style={{ fontSize: 15, color: '#52525b', maxWidth: 480, lineHeight: 1.55, marginBottom: 28 }}>
        The link you followed is broken, or the page has moved. Head back to the site or jump
        straight into your workspace.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '10px 18px',
            borderRadius: 999,
            background: 'oklch(0.72 0.18 55)',
            color: 'white',
            fontWeight: 500,
            fontSize: 14,
            textDecoration: 'none',
          }}
        >
          Back to homepage
        </Link>
        <Link
          href="/dashboard"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '10px 18px',
            borderRadius: 999,
            background: 'transparent',
            color: 'inherit',
            border: '1px solid #d4d4d8',
            fontWeight: 500,
            fontSize: 14,
            textDecoration: 'none',
          }}
        >
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
