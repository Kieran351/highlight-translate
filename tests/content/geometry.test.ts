import { describe, expect, it } from 'vitest';

import { endpointFromSelection, placeOverlay } from '../../src/content/geometry';

describe('overlay geometry', () => {
  it('places an overlay after the selection endpoint when space is available', () => {
    expect(placeOverlay(
      { left: 100, right: 200, top: 100, bottom: 130 },
      { width: 40, height: 40 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 208, y: 138, visible: true });
  });

  it('flips and clamps the overlay at the viewport edges', () => {
    expect(placeOverlay(
      { left: 770, right: 795, top: 570, bottom: 595 },
      { width: 100, height: 100 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 662, y: 462, visible: true });
  });

  it('marks an anchor outside the viewport as not visible', () => {
    expect(placeOverlay(
      { left: 100, right: 200, top: 700, bottom: 730 },
      { width: 40, height: 40 },
      { width: 800, height: 600 },
      8,
    ).visible).toBe(false);
  });

  it('uses the focus endpoint so reverse selections anchor at the mouse release side', () => {
    expect(endpointFromSelection({
      anchorNode: {} as Node,
      anchorOffset: 12,
      focusNode: {} as Node,
      focusOffset: 3,
    })).toMatchObject({ offset: 3 });
  });
});
