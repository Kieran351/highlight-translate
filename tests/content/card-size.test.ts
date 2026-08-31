import { describe, expect, it } from 'vitest';

import { createCardSizeState, reduceCardSize, resolveUserCardSize } from '../../src/content/card-size';
import type { CardSizeEvent, CardSizeState } from '../../src/content/card-size';

const CARD = { width: 480, height: 300 };
const VIEWPORT = { width: 800, height: 600 };

type PointerDownEvent = Extract<CardSizeEvent, { type: 'pointer-down' }>;
type PointerMoveEvent = Extract<CardSizeEvent, { type: 'pointer-move' }>;
type PointerUpEvent = Extract<CardSizeEvent, { type: 'pointer-up' }>;

function down(overrides: Partial<PointerDownEvent> = {}): PointerDownEvent {
  return {
    type: 'pointer-down',
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    pointer: { x: 400, y: 300 },
    cardSize: CARD,
    requestActivity: 'stopped',
    ...overrides,
  };
}

function move(overrides: Partial<PointerMoveEvent> = {}): PointerMoveEvent {
  return {
    type: 'pointer-move',
    pointerId: 1,
    buttons: 1,
    pointer: { x: 400, y: 300 },
    viewport: VIEWPORT,
    ...overrides,
  };
}

function up(overrides: Partial<PointerUpEvent> = {}): PointerUpEvent {
  return {
    type: 'pointer-up',
    pointerId: 1,
    buttons: 0,
    pointer: { x: 400, y: 300 },
    viewport: VIEWPORT,
    ...overrides,
  };
}

describe('card size state', () => {
  it('starts in automatic size mode and idle', () => {
    expect(createCardSizeState()).toEqual({
      mode: { kind: 'auto' },
      resize: { kind: 'idle' },
    });
  });

  it('accepts a primary mouse press on a stopped request', () => {
    const state = reduceCardSize(createCardSizeState(), down());
    expect(state.mode).toEqual({ kind: 'auto' });
    expect(state.resize).toEqual({
      kind: 'pending',
      pointerId: 1,
      pointerStart: { x: 400, y: 300 },
      sizeStart: CARD,
    });
  });

  it('rejects active, non-mouse, secondary and non-primary presses', () => {
    const initial = createCardSizeState();
    expect(reduceCardSize(initial, down({ requestActivity: 'active' }))).toBe(initial);
    expect(reduceCardSize(initial, down({ pointerType: 'touch' }))).toBe(initial);
    expect(reduceCardSize(initial, down({ pointerType: 'pen' }))).toBe(initial);
    expect(reduceCardSize(initial, down({ button: 2 }))).toBe(initial);
    expect(reduceCardSize(initial, down({ isPrimary: false }))).toBe(initial);
  });

  it('keeps exactly four pixels pending and then uses the complete displacement', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, move({ pointer: { x: 404, y: 300 } }));
    expect(state.mode).toEqual({ kind: 'auto' });
    expect(state.resize.kind).toBe('pending');

    state = reduceCardSize(state, move({ pointer: { x: 405, y: 300 } }));
    expect(state.mode).toEqual({ kind: 'user', target: { width: 485, height: 300 } });
    expect(state.resize).toMatchObject({ kind: 'resizing', pointerId: 1 });
  });

  it('clamps both axes to the regular minimum and viewport maximum', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, move({ pointer: { x: 300, y: 100 } }));
    expect(state.mode).toEqual({ kind: 'user', target: { width: 380, height: 220 } });

    state = reduceCardSize(state, move({ pointer: { x: 1000, y: 1000 } }));
    expect(state.mode).toEqual({ kind: 'user', target: { width: 784, height: 584 } });
  });

  it('preserves the target while resolving a temporary small viewport size', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, move({ pointer: { x: 520, y: 500 } }));
    expect(state.mode).toEqual({ kind: 'user', target: { width: 600, height: 500 } });

    expect(resolveUserCardSize(state, { width: 320, height: 200 })).toEqual({
      width: 304,
      height: 184,
    });
    expect(state.mode).toEqual({ kind: 'user', target: { width: 600, height: 500 } });
    expect(resolveUserCardSize(state, VIEWPORT)).toEqual({ width: 600, height: 500 });
  });

  it('allows a new gesture in a small viewport to replace the old target', () => {
    let state: CardSizeState = {
      mode: { kind: 'user', target: { width: 600, height: 500 } },
      resize: { kind: 'idle' },
    };
    state = reduceCardSize(state, down({ cardSize: { width: 304, height: 184 } }));
    state = reduceCardSize(state, move({ pointer: { x: 500, y: 350 }, viewport: { width: 400, height: 300 } }));
    expect(state.mode).toEqual({ kind: 'user', target: { width: 384, height: 234 } });
  });

  it('ends a pending press without switching mode', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, up({ pointer: { x: 402, y: 301 } }));
    expect(state).toEqual(createCardSizeState());
  });

  it('consumes the release point and keeps the last legal target on cancel', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, move({ pointer: { x: 430, y: 330 } }));
    state = reduceCardSize(state, up({ pointer: { x: 460, y: 350 } }));
    expect(state).toEqual({
      mode: { kind: 'user', target: { width: 540, height: 350 } },
      resize: { kind: 'idle' },
    });

    state = reduceCardSize(state, down({ cardSize: { width: 540, height: 350 } }));
    state = reduceCardSize(state, move({ pointer: { x: 360, y: 230 } }));
    state = reduceCardSize(state, { type: 'pointer-cancel', pointerId: 1 });
    expect(state).toEqual({
      mode: { kind: 'user', target: { width: 500, height: 280 } },
      resize: { kind: 'idle' },
    });
    expect(reduceCardSize(state, { type: 'pointer-cancel', pointerId: 1 })).toBe(state);
  });

  it('ends a gesture when the main button is lost and on request start', () => {
    let pending = reduceCardSize(createCardSizeState(), down());
    pending = reduceCardSize(pending, move({ pointer: { x: 404, y: 300 }, buttons: 0 }));
    expect(pending).toEqual(createCardSizeState());

    let resizing = reduceCardSize(createCardSizeState(), down());
    resizing = reduceCardSize(resizing, move({ pointer: { x: 430, y: 330 } }));
    resizing = reduceCardSize(resizing, move({ pointer: { x: 500, y: 500 }, buttons: 0 }));
    expect(resizing).toEqual({
      mode: { kind: 'user', target: { width: 510, height: 330 } },
      resize: { kind: 'idle' },
    });

    resizing = reduceCardSize(resizing, down({ cardSize: { width: 510, height: 330 } }));
    resizing = reduceCardSize(resizing, move({ pointer: { x: 430, y: 330 } }));
    resizing = reduceCardSize(resizing, { type: 'request-started' });
    expect(resizing).toEqual({
      mode: { kind: 'user', target: { width: 540, height: 360 } },
      resize: { kind: 'idle' },
    });
  });

  it('ignores events from other pointers', () => {
    let state = reduceCardSize(createCardSizeState(), down());
    state = reduceCardSize(state, move({ pointerId: 2, pointer: { x: 500, y: 500 } }));
    expect(state.resize.kind).toBe('pending');
    state = reduceCardSize(state, up({ pointerId: 2, pointer: { x: 500, y: 500 } }));
    expect(state.resize.kind).toBe('pending');
  });
});
