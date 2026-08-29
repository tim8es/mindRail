import { describe, expect, it } from 'vitest';

import { getFoundationStatus } from '../src/foundation.ts';

describe('development foundation', () => {
  it('does not represent the product runtime as implemented', () => {
    expect(getFoundationStatus()).toEqual({
      version: '0.1',
      runtimeImplemented: false,
    });
  });
});
