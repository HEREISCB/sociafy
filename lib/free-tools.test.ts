import { describe, it, expect } from 'vitest';
import { parseResults } from './free-tools';

describe('parseResults', () => {
  it('reads the JSON shape we ask for', () => {
    expect(parseResults('{"results": [" one ", "two", ""]}')).toEqual(['one', 'two']);
  });
  it('accepts a bare array or fenced JSON', () => {
    expect(parseResults('["a","b"]')).toEqual(['a', 'b']);
    expect(parseResults('```json\n{"options":["x"]}\n```')).toEqual(['x']);
  });
  it('falls back to lines, stripping bullets and numbers', () => {
    expect(parseResults('1. First\n- Second\n\n• Third')).toEqual(['First', 'Second', 'Third']);
  });
  it('drops non-strings and caps the count', () => {
    expect(parseResults('{"results":[1,"a",null,"b","c"]}', 2)).toEqual(['a', 'b']);
  });
});

describe('parseResults on truncated JSON', () => {
  it('keeps the strings that closed and drops the cut-off one', async () => {
    const { parseResults } = await import('./free-tools');
    const raw = '{"results": ["#a #b", "#c \\"d\\"", "#e #f #g';
    expect(parseResults(raw)).toEqual(['#a #b', '#c "d"']);
  });
});
