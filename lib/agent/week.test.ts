import { describe, it, expect } from 'vitest';
import { spreadKinds, projectWeek, weekDays, dayIndex } from './week';
import { parseTopic, topicLabel } from './topics';

describe('spreadKinds', () => {
  it('keeps the mix counts and spreads media through the week', () => {
    const k = spreadKinds({ text: 2, image: 2, video: 1 });
    expect(k).toHaveLength(5);
    expect(k.filter((x) => x === 'image')).toHaveLength(2);
    expect(k.filter((x) => x === 'video')).toHaveLength(1);
    expect(k[0]).not.toBe(k[1]); // not every image first
  });
  it('handles an empty mix', () => {
    expect(spreadKinds({ text: 0, image: 0, video: 0 })).toEqual([]);
  });
});

describe('projectWeek', () => {
  const from = new Date('2026-10-22T03:00:00Z');
  it('projects only what is missing, inside the week, in order', () => {
    const p = projectWeek({ from, mix: { text: 4, image: 1, video: 0 }, have: { text: 1 } });
    expect(p).toHaveLength(4);
    expect(p.filter((s) => s.kind === 'image')).toHaveLength(1);
    const end = from.getTime() + 7 * 864e5;
    expect(p.every((s) => s.at.getTime() > from.getTime() && s.at.getTime() < end)).toBe(true);
    expect([...p].sort((a, b) => +a.at - +b.at)).toEqual(p);
  });
  it('is stable across calls (no flicker while tweaking)', () => {
    const a = projectWeek({ from, mix: { text: 3, image: 1, video: 1 } });
    expect(projectWeek({ from, mix: { text: 3, image: 1, video: 1 } })).toEqual(a);
  });
  it('projects nothing when the week already holds the mix', () => {
    expect(projectWeek({ from, mix: { text: 2, image: 0, video: 0 }, have: { text: 3 } })).toEqual([]);
  });
});

describe('weekDays / dayIndex', () => {
  it('maps times onto the seven local days, clamped', () => {
    const days = weekDays(new Date(2026, 9, 22, 15));
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual(new Date(2026, 9, 22));
    expect(dayIndex(new Date(2026, 9, 24, 9), days)).toBe(2);
    expect(dayIndex(new Date(2026, 9, 30, 9), days)).toBe(6);
    expect(dayIndex(new Date(2026, 9, 21, 9), days)).toBe(0);
  });
});

describe('topics', () => {
  it('normalises typed topics and rejects sentences and URLs', () => {
    expect(parseTopic('  Filter Coffee ')).toEqual({ id: 'filter-coffee' });
    expect(parseTopic('')).toBeNull();
    expect(parseTopic('we sell the best coffee in town')).toHaveProperty('error');
    expect(parseTopic('thirdwave.in')).toHaveProperty('error');
  });
  it('labels known and custom ids', () => {
    expect(topicLabel('food-drink')).toBe('Food & drink');
    expect(topicLabel('home-brewing')).toBe('home brewing');
  });
});
