'use client';

import React, { useState } from 'react';
import { Icon } from '../icons';
import { Seg } from '../ui';
import type { AssetRef } from '../../lib/brand/kit';

const UPLOAD_ERRORS: Record<string, string> = {
  unsupported_type: 'That file type isn’t supported here.',
  file_too_large: 'That file is too large.',
  unsafe_svg: 'This SVG has scripts or external links we can’t keep. Re-export it as a plain SVG, or upload a PNG.',
  r2_not_configured: 'Uploads aren’t available right now.',
};

/** Upload through the shared media pipeline; the server types, caps and sanitizes the file. */
export async function uploadBrandFile(file: File, label: string): Promise<AssetRef> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('purpose', 'brand');
  fd.append('label', label);
  const r = await fetch('/api/media/upload', { method: 'POST', body: fd, credentials: 'include' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const max = typeof body.max === 'number' ? ` The limit is ${Math.round(body.max / 1024 / 1024)} MB.` : '';
    throw new Error((UPLOAD_ERRORS[body.error] ?? 'Upload failed. Try again.') + max);
  }
  return { id: body.id, url: body.publicUrl, mime: body.mimeType, name: file.name.slice(0, 200) };
}

/** A button that opens the file picker. */
export function FilePick({ label, accept, multiple, disabled, primary, onFiles }: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Ink fill: the one action that unlocks something (e.g. the missing logo). */
  primary?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <label className={`btn sm bk-pick${primary ? ' primary' : ''}`} aria-disabled={disabled || undefined}>
      <Icon name="upload" size={12} /> {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

/** Text input/textarea that saves on blur when the value changed. */
export function BlurField({ label, hint, value, onSave, multiline, maxLength, placeholder, type = 'text' }: {
  label: string;
  hint?: string;
  value: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  type?: string;
}) {
  const [v, setV] = useState(value);
  // Follow the saved value when it changes underneath (React's "adjust state on prop change").
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setV(value); }
  const props = {
    className: 'input',
    value: v,
    maxLength,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => v.trim() !== value.trim() && onSave(v.trim()),
  };
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {multiline ? <textarea rows={3} {...props} /> : <input type={type} {...props} />}
      {(hint || maxLength) && (
        <span className="set-hint">
          {hint}
          {hint && maxLength ? ' · ' : ''}
          {maxLength ? <span className="tnum">{v.length}/{maxLength}</span> : null}
        </span>
      )}
    </label>
  );
}

/** One line per entry. Saves the trimmed, non-empty lines on blur. */
export function LinesField({ label, hint, value, max, maxChars, onSave }: {
  label: string;
  hint?: string;
  value: string[];
  max: number;
  maxChars: number;
  onSave: (lines: string[]) => void;
}) {
  const joined = value.join('\n');
  const [v, setV] = useState(joined);
  const [seen, setSeen] = useState(joined);
  if (seen !== joined) { setSeen(joined); setV(joined); }
  const lines = v.split('\n').map((l) => l.trim()).filter(Boolean);
  const tooMany = lines.length > max;
  const tooLong = lines.some((l) => l.length > maxChars);
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      <textarea
        className="input"
        rows={Math.min(Math.max(lines.length + 1, 3), max + 1)}
        value={v}
        aria-invalid={tooMany || tooLong || undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !tooMany && !tooLong && lines.join('\n') !== joined && onSave(lines)}
      />
      <span className={`set-hint${tooMany || tooLong ? ' err' : ''}`}>
        {tooMany ? `Keep it to ${max} lines.` : tooLong ? `Each line can be up to ${maxChars} characters.` : hint}
        {' '}<span className="tnum">{lines.length}/{max}</span>
      </span>
    </label>
  );
}

/** Segmented single choice with a sliding ink indicator. */
export function Segmented<T extends string>({ label, hint, value, options, onChange }: {
  label: string;
  hint?: string;
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="set-field">
      <span className="set-label set-label--row">{label}{hint && <span className="set-hint">{hint}</span>}</span>
      <Seg label={label} size="sm" value={(value ?? '') as T} options={options.map((o) => ({ id: o.value, label: o.label }))} onChange={(v) => v !== value && onChange(v)} />
    </div>
  );
}
