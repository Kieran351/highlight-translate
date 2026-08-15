import { describe, expect, it } from 'vitest';

import { constrainOverlayPosition, endpointFromSelection, placeOverlay } from '../../src/content/geometry';

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

describe('constrainOverlayPosition', () => {
  const viewport = { width: 800, height: 600 };

  it('keeps a legal position unchanged on both axes', () => {
    expect(constrainOverlayPosition(
      { x: 120, y: 90 },
      { width: 200, height: 150 },
      viewport,
    )).toEqual({ x: 120, y: 90 });
  });

  it('clamps only the offending axis when the card crosses the left edge', () => {
    expect(constrainOverlayPosition(
      { x: -40, y: 200 },
      { width: 100, height: 100 },
      viewport,
    )).toEqual({ x: 8, y: 200 });
  });

  it('clamps only the offending axis when the card crosses the top edge', () => {
    expect(constrainOverlayPosition(
      { x: 300, y: -5 },
      { width: 100, height: 100 },
      viewport,
    )).toEqual({ x: 300, y: 8 });
  });

  it('keeps the 8px margin at the right and bottom edges', () => {
    expect(constrainOverlayPosition(
      { x: 900, y: 700 },
      { width: 100, height: 100 },
      viewport,
    )).toEqual({ x: 692, y: 492 });
  });

  it('clamps both axes at each corner', () => {
    expect(constrainOverlayPosition(
      { x: -20, y: -20 },
      { width: 100, height: 100 },
      viewport,
    )).toEqual({ x: 8, y: 8 });
    expect(constrainOverlayPosition(
      { x: 2000, y: 2000 },
      { width: 100, height: 100 },
      viewport,
    )).toEqual({ x: 692, y: 492 });
  });

  it('applies minimal correction when the viewport shrinks around a free position', () => {
    const shrunk = { width: 400, height: 300 };
    expect(constrainOverlayPosition(
      { x: 120, y: 90 },
      { width: 200, height: 150 },
      shrunk,
    )).toEqual({ x: 120, y: 90 });
    expect(constrainOverlayPosition(
      { x: 350, y: 90 },
      { width: 200, height: 150 },
      shrunk,
    )).toEqual({ x: 192, y: 90 });
  });

  it('applies minimal correction when the card grows beyond the free position', () => {
    expect(constrainOverlayPosition(
      { x: 650, y: 90 },
      { width: 300, height: 150 },
      viewport,
    )).toEqual({ x: 492, y: 90 });
  });

  it('falls back to the deterministic margin origin when the safe area cannot fit the card', () => {
    expect(constrainOverlayPosition(
      { x: 200, y: 200 },
      { width: 795, height: 595 },
      viewport,
    )).toEqual({ x: 8, y: 8 });
  });
});
