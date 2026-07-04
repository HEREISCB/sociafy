'use client';

import React, { useEffect } from 'react';
import { Icon } from '../icons';

/** Large centered modal used by the shield toolbar to host the Brand Knowledge
 *  and Response-AI editors. Closes on backdrop click or Escape. */
const Modal: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }> = ({
  title,
  subtitle,
  onClose,
  children,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)', display: 'grid', placeItems: 'center', zIndex: 1000, padding: 24 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: 'min(900px, 100%)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
          border: '1px solid var(--line-2)',
          borderRadius: 'var(--r-lg)',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,0.32)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="btn sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
};

export default Modal;
