import { describe, it, expect } from 'vitest';
import { scoreMention } from './sentiment';

const label = (title: string, body = '') => scoreMention(title, body).label;

describe('scoreMention — genuine crises still fire', () => {
  it('data breach', () => {
    expect(label('Acme hit by data breach', 'Customer records were stolen from an unsecured server.')).toBe('crisis');
  });

  it('lawsuit', () => {
    expect(label('Class action lawsuit filed against Acme over billing')).toBe('crisis');
  });

  it('fraud', () => {
    expect(label('Regulator accuses Acme of fraud')).toBe('crisis');
  });

  it('two distinct crisis-adjacent words together', () => {
    // "investigation" alone is routine; investigation + arrest is not.
    expect(label('Acme executive arrested as investigation widens')).toBe('crisis');
  });
});

describe('scoreMention — routine news is not a crisis', () => {
  it('"issues guidance" is neutral, not negative', () => {
    expect(label('Zomato issues Q3 guidance')).toBe('neutral');
  });

  it('common neutral words no longer read negative', () => {
    expect(label('Acme addresses pricing concerns in critical infrastructure update')).toBe('neutral');
    expect(label('Acme refund policy updated; alleged downtime report was withdrawn')).toBe('neutral');
  });

  it('a single repeated "investigation" is not a brand crisis', () => {
    // Real production row: Malaysia Airlines Flight 17, stored as a "crisis"
    // for a municipal council.
    expect(label('Investigation update', 'The responsibility for investigation was delegated to the joint investigation team.')).not.toBe('crisis');
  });

  it('a routine arrest report is not a crisis on its own', () => {
    expect(label('Three arrested after extortion attempt')).not.toBe('crisis');
  });
});

describe('scoreMention — real negativity still detected', () => {
  it('an angry complaint is negative', () => {
    expect(label('Terrible experience', 'The app is broken and crashing constantly — worst update ever.')).toBe('negative');
  });

  it('two negative words are enough', () => {
    expect(label('Users frustrated by outage')).toBe('negative');
  });
});

describe('scoreMention — positive is reachable', () => {
  it('one positive word with nothing negative reads positive', () => {
    expect(label('Zomato launches delightful new feature, users love it')).toBe('positive');
    expect(label('Acme wins award for best customer service')).toBe('positive');
  });

  it('mixed news stays neutral rather than flipping to positive', () => {
    expect(label('Great launch, but the rollout was a disaster')).toBe('neutral');
  });

  it('plain factual news stays neutral', () => {
    expect(label('New Delhi Municipal Council to host G20 food festival')).toBe('neutral');
  });
});
