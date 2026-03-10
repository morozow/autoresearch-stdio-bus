import { describe, it, expect } from 'vitest';
import { VERSION } from './index.js';

describe('swarm module', () => {
  it('exports version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
