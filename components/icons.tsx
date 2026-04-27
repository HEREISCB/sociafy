'use client';

import React from 'react';

type IconName =
  | 'home' | 'sparkle' | 'calendar' | 'chart' | 'inbox' | 'settings'
  | 'plus' | 'search' | 'bell' | 'arrow_right' | 'arrow_up_right'
  | 'arrow_up' | 'arrow_down' | 'check' | 'x' | 'edit' | 'trash'
  | 'image' | 'play' | 'pause' | 'bolt' | 'refresh' | 'clock' | 'pin'
  | 'trend' | 'chat' | 'mic' | 'chevron_down' | 'chevron_right'
  | 'chevron_left' | 'more' | 'upload' | 'eye' | 'heart' | 'bookmark'
  | 'send' | 'fire' | 'globe' | 'lock' | 'waveform' | 'target'
  | 'folder' | 'grid' | 'list' | 'filter' | 'link' | 'book' | 'fork';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, ...props }) => {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 8.5L8 3.5l5 5V13a1 1 0 01-1 1h-2.5v-4h-3v4H4a1 1 0 01-1-1V8.5z"/></>,
    sparkle: <><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l2 2M9.5 9.5l2 2M11.5 4.5l-2 2M6.5 9.5l-2 2"/></>,
    calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></>,
    chart: <><path d="M2.5 13.5V2.5M2.5 13.5h11M5 11V8M8 11V5M11 11V9"/></>,
    inbox: <><path d="M2.5 8.5l1.5-5h8l1.5 5v4a1 1 0 01-1 1h-9a1 1 0 01-1-1v-4z"/><path d="M2.5 8.5h3l1 2h3l1-2h3"/></>,
    settings: <><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5"/></>,
    plus: <><path d="M8 3.5v9M3.5 8h9"/></>,
    search: <><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></>,
    bell: <><path d="M4 7a4 4 0 018 0v2l1.5 2.5h-11L4 9V7z"/><path d="M6.5 12a1.5 1.5 0 003 0"/></>,
    arrow_right: <><path d="M3.5 8h9M9 4.5l3.5 3.5L9 11.5"/></>,
    arrow_up_right: <><path d="M5.5 10.5l5-5M6 5.5h4.5V10"/></>,
    arrow_up: <><path d="M8 13V3M4.5 6.5L8 3l3.5 3.5"/></>,
    arrow_down: <><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5"/></>,
    check: <><path d="M3 8l3.5 3.5L13 5"/></>,
    x: <><path d="M4 4l8 8M12 4l-8 8"/></>,
    edit: <><path d="M3 13l1-3 7-7 2 2-7 7-3 1z"/></>,
    trash: <><path d="M3 4.5h10M5.5 4.5V3a1 1 0 011-1h3a1 1 0 011 1v1.5M4.5 4.5V13a1 1 0 001 1h5a1 1 0 001-1V4.5"/></>,
    image: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="6" cy="6" r="1"/><path d="M2.5 11l3-3 3 3 2-2 2.5 2.5"/></>,
    play: <><path d="M5 3.5L12 8l-7 4.5v-9z"/></>,
    pause: <><path d="M5.5 3v10M10.5 3v10"/></>,
    bolt: <><path d="M8.5 2L4 9h3.5L7 14l4.5-7H8l.5-5z"/></>,
    refresh: <><path d="M2.5 8a5.5 5.5 0 019.5-3.5M13.5 8a5.5 5.5 0 01-9.5 3.5"/><path d="M11.5 1.5v3h-3M4.5 14.5v-3h3"/></>,
    clock: <><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></>,
    pin: <><path d="M8 1.5l2 4 4 .5-3 3 .5 4-3.5-2-3.5 2 .5-4-3-3 4-.5 2-4z"/></>,
    trend: <><path d="M2 11l4-4 3 2 5-5"/><path d="M10 4h4v4"/></>,
    chat: <><path d="M2.5 4a1 1 0 011-1h9a1 1 0 011 1v6a1 1 0 01-1 1H7l-3 2.5V11h-.5a1 1 0 01-1-1V4z"/></>,
    mic: <><rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 8.5a4.5 4.5 0 009 0M8 13v2"/></>,
    chevron_down: <><path d="M4 6l4 4 4-4"/></>,
    chevron_right: <><path d="M6 4l4 4-4 4"/></>,
    chevron_left: <><path d="M10 4L6 8l4 4"/></>,
    more: <><circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></>,
    upload: <><path d="M8 11V2M4.5 5.5L8 2l3.5 3.5M3 13.5h10"/></>,
    eye: <><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></>,
    heart: <><path d="M8 13.5L2.5 8a3 3 0 014.5-4l1 1 1-1a3 3 0 014.5 4L8 13.5z"/></>,
    bookmark: <><path d="M4 2.5h8v11l-4-2.5-4 2.5v-11z"/></>,
    send: <><path d="M14 2L7 9M14 2l-4 12-3-5-5-3 12-4z"/></>,
    fire: <><path d="M8 14c2.5 0 4.5-2 4.5-4.5 0-2-1.5-3.5-1.5-5.5 0 1.5-1 2.5-2 2.5 0-2-1-3-2-4-1 3-3.5 4.5-3.5 7.5C3.5 12 5.5 14 8 14z"/></>,
    globe: <><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.5 1.5 2.5 3.5 2.5 5.5s-1 4-2.5 5.5c-1.5-1.5-2.5-3.5-2.5-5.5s1-4 2.5-5.5z"/></>,
    lock: <><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></>,
    waveform: <><path d="M2 8h1M4.5 5v6M7 3v10M9.5 5v6M12 7v2M14 8h.5"/></>,
    target: <><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/></>,
    folder: <><path d="M2 4.5a1 1 0 011-1h3l1.5 1.5h5.5a1 1 0 011 1V12a1 1 0 01-1 1h-10a1 1 0 01-1-1V4.5z"/></>,
    grid: <><rect x="2.5" y="2.5" width="4.5" height="4.5"/><rect x="9" y="2.5" width="4.5" height="4.5"/><rect x="2.5" y="9" width="4.5" height="4.5"/><rect x="9" y="9" width="4.5" height="4.5"/></>,
    list: <><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></>,
    filter: <><path d="M2 3.5h12L9 9v4l-2 1V9L2 3.5z"/></>,
    link: <><path d="M6.5 9.5l3-3M5 11l-1 1a2.5 2.5 0 01-3.5-3.5l2.5-2.5a2.5 2.5 0 013.5 0M11 5l1-1a2.5 2.5 0 013.5 3.5l-2.5 2.5a2.5 2.5 0 01-3.5 0"/></>,
    book: <><path d="M2.5 3.5h5a2 2 0 012 2v8a2 2 0 00-2-2h-5v-8zM13.5 3.5h-5a2 2 0 00-2 2v8a2 2 0 012-2h5v-8z"/></>,
    fork: <><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="8" cy="13" r="1.5"/><path d="M4 4.5v3a2 2 0 002 2h4a2 2 0 002-2v-3M8 9.5v2"/></>,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name] || null}
    </svg>
  );
};

interface PglyphProps {
  p: string;
  size?: 'lg' | 'xl';
  className?: string;
}

export const Pglyph: React.FC<PglyphProps> = ({ p, size, className }) => {
  const labels: Record<string, string> = { ig: 'Ig', fb: 'f', x: '𝕏', li: 'in', tt: 'T', yt: 'Yt' };
  return (
    <span className={`pglyph ${p}${size ? ' ' + size : ''}${className ? ' ' + className : ''}`}>
      {labels[p]}
    </span>
  );
};

interface SparkProps {
  data: number[];
  color?: string;
  w?: number;
  h?: number;
}

export const Spark: React.FC<SparkProps> = ({ data, color = 'currentColor', w = 64, h = 28 }) => {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none">
      <polyline points={pts} stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
