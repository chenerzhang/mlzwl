import { describe, expect, it } from 'vitest';
import { objectFitFor } from './frame-mode';

describe('objectFitFor', () => {
  it('maps every mode to the same-named object-fit value', () => {
    expect(objectFitFor('contain')).toBe('contain');
    expect(objectFitFor('cover')).toBe('cover');
    expect(objectFitFor('fill')).toBe('fill');
  });
});
