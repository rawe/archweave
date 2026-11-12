import { describe, expect, it } from 'vitest';
import { Element } from '../../src/shared/model.ts';
import { fieldLinkTargets } from '../../src/web/lib/fieldLinks.ts';

describe('fieldLinkTargets', () => {
  it('offers every other structure but not the structure itself', () => {
    const data = ['order', 'customer', 'address'].map((id) => Element.parse({ id, kind: 'data', name: id }));
    expect(fieldLinkTargets(data, 'order').map((d) => d.id)).toEqual(['customer', 'address']);
  });
});
