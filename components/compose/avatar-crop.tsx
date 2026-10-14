'use client';

import React, { useEffect, useRef, useState } from 'react';

/** Output pixels per aspect — the avatar engine's tier dimensions. */
const ASPECT: Record<string, { w: number; h: number; out: [number, number] }> = {
  '9:16': { w: 9, h: 16, out: [720, 1280] },
  '1:1': { w: 1, h: 1, out: [768, 768] },
  '16:9': { w: 16, h: 9, out: [1280, 720] },
};
const LONG = 300;

/**
 * Crop the avatar face photo to the video's aspect so the engine gets a photo
 * that already fits. Drag to pan, slider to zoom. Works on the local File so
 * the canvas is never cross-origin-tainted.
 */
export function AvatarCropModal({ file, aspect, onApply, onCancel }: {
  file: File;
  aspect: string;
  onApply: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const spec = ASPECT[aspect] ?? ASPECT['9:16'];
  const [vw, vh] = spec.h >= spec.w ? [Math.round((LONG * spec.w) / spec.h), LONG] : [LONG, Math.round((LONG * spec.h) / spec.w)];
  const [src, setSrc] = useState('');
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // "cover" base scale, then the user's zoom on top; pan is clamped to the edges.
  const scale = (nat ? Math.max(vw / nat.w, vh / nat.h) : 1) * zoom;
  const dispW = nat ? nat.w * scale : 0;
  const dispH = nat ? nat.h * scale : 0;
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const ox = clamp(off.x, Math.max(0, (dispW - vw) / 2));
  const oy = clamp(off.y, Math.max(0, (dispH - vh) / 2));

  const apply = () => {
    if (!nat || !imgRef.current) return;
    const [outW, outH] = spec.out;
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const left = vw / 2 - dispW / 2 + ox;
    const top = vh / 2 - dispH / 2 + oy;
    ctx.drawImage(imgRef.current, -left / scale, -top / scale, vw / scale, vh / scale, 0, 0, outW, outH);
    canvas.toBlob((b) => { if (b) onApply(b); }, 'image/png');
  };

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal-sheet compose-crop" role="dialog" aria-modal="true" aria-label={`Crop to ${aspect}`} onClick={(e) => e.stopPropagation()}>
        <h3>Crop to {aspect}</h3>
        <p className="compose-note">Drag to position, slide to zoom.</p>
        <div
          className="compose-crop-frame"
          style={{ width: vw, height: vh }}
          onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, ox, oy }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (drag.current) setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y }); }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{ width: dispW || 'auto', height: dispH || 'auto', transform: `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))` }}
            />
          )}
        </div>
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
        <div className="row compose-crop-actions">
          <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn sm" onClick={() => onApply(file)}>Use original</button>
          <button type="button" className="btn primary sm" onClick={apply} disabled={!nat}>Apply crop</button>
        </div>
      </div>
    </div>
  );
}
