import { describe, expect, it } from 'vitest';

import { createCardPositionState, reduceCardPosition } from '../../src/content/card-position';
import type { CardPositionEvent, CardPositionState } from '../../src/content/card-position';

type PointerDownEvent = Extract<CardPositionEvent, { type: 'pointer-down' }>;
type PointerMoveEvent = Extract<CardPositionEvent, { type: 'pointer-move' }>;
type PointerUpEvent = Extract<CardPositionEvent, { type: 'pointer-up' }>;

const CARD = { width: 200, height: 150 };
const VIEWPORT = { width: 800, height: 600 };

function down(overrides: Partial<PointerDownEvent> = {}): PointerDownEvent {
  return {
    type: 'pointer-down',
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    pointer: { x: 400, y: 300 },
    card: { x: 200, y: 150 },
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
    cardSize: CARD,
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
    cardSize: CARD,
    viewport: VIEWPORT,
    ...overrides,
  };
}

describe('card position state', () => {
  it('starts anchored and idle', () => {
    expect(createCardPositionState()).toEqual({
      position: { kind: 'anchored' },
      drag: { kind: 'idle' },
    });
  });

  it('accepts a primary mouse press on a stopped request as pending', () => {
    const state = reduceCardPosition(createCardPositionState(), down());
    expect(state.position).toEqual({ kind: 'anchored' });
    expect(state.drag).toMatchObject({ kind: 'pending', pointerId: 1 });
    expect(state.drag).toMatchObject({ pointerStart: { x: 400, y: 300 }, cardStart: { x: 200, y: 150 } });
  });

  it('rejects presses while the request is active', () => {
    const initial = createCardPositionState();
    expect(reduceCardPosition(initial, down({ requestActivity: 'active' }))).toBe(initial);
  });

  it('rejects touch, pen, right-button and non-primary presses', () => {
    const initial = createCardPositionState();
    expect(reduceCardPosition(initial, down({ pointerType: 'touch' }))).toBe(initial);
    expect(reduceCardPosition(initial, down({ pointerType: 'pen' }))).toBe(initial);
    expect(reduceCardPosition(initial, down({ button: 2 }))).toBe(initial);
    expect(reduceCardPosition(initial, down({ isPrimary: false }))).toBe(initial);
  });

  it('ignores a second pointer while a session is open', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, down({ pointerId: 2, pointer: { x: 500, y: 350 } }));
    expect(state.drag).toMatchObject({ kind: 'pending', pointerId: 1 });
  });

  it('keeps anchoring while movement stays within exactly 4px', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 404, y: 300 } }));
    expect(state.position).toEqual({ kind: 'anchored' });
    expect(state.drag).toMatchObject({ kind: 'pending' });
    state = reduceCardPosition(state, move({ pointer: { x: 403, y: 302 } }));
    expect(state.drag).toMatchObject({ kind: 'pending' });
    expect(state.position).toEqual({ kind: 'anchored' });
  });

  it('starts a free drag once the euclidean distance exceeds 4px', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 404, y: 301 } }));
    expect(state.position).toEqual({ kind: 'free', x: 204, y: 151 });
    expect(state.drag).toMatchObject({ kind: 'dragging', pointerId: 1 });
  });

  it('moves the card by the pointer displacement from the press origin without jumping', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 410, y: 300 } }));
    expect(state.position).toEqual({ kind: 'free', x: 210, y: 150 });

    state = reduceCardPosition(state, move({ pointer: { x: 370, y: 260 } }));
    expect(state.position).toEqual({ kind: 'free', x: 170, y: 110 });
    expect(state.drag).toMatchObject({ kind: 'dragging' });
  });

  it('does not discard the pre-threshold displacement when the drag starts', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 404, y: 300 } }));
    state = reduceCardPosition(state, move({ pointer: { x: 405, y: 300 } }));
    expect(state.position).toEqual({ kind: 'free', x: 205, y: 150 });
  });

  it('constrains every drag update to the viewport with the 8px margin', () => {
    let state = reduceCardPosition(createCardPositionState(), down({ card: { x: 600, y: 440 } }));
    state = reduceCardPosition(state, move({ pointer: { x: 900, y: 700 } }));
    expect(state.position).toEqual({ kind: 'free', x: 592, y: 442 });
  });

  it('ignores moves and releases from other pointers', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointerId: 7, pointer: { x: 500, y: 500 } }));
    expect(state.drag).toMatchObject({ kind: 'pending' });
    state = reduceCardPosition(state, up({ pointerId: 7, pointer: { x: 500, y: 500 } }));
    expect(state.drag).toMatchObject({ kind: 'pending' });
  });

  it('ends a pending press on release without leaving the anchor', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, up({ pointer: { x: 402, y: 301 } }));
    expect(state).toEqual(createCardPositionState());
  });

  it('consumes the release point as the final free position', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 410, y: 300 } }));
    state = reduceCardPosition(state, up({ pointer: { x: 460, y: 330 } }));
    expect(state).toEqual({
      position: { kind: 'free', x: 260, y: 180 },
      drag: { kind: 'idle' },
    });
  });

  it('ends the gesture but keeps the last legal position on pointer cancel', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 430, y: 310 } }));
    state = reduceCardPosition(state, { type: 'pointer-cancel', pointerId: 1 });
    expect(state).toEqual({
      position: { kind: 'free', x: 230, y: 160 },
      drag: { kind: 'idle' },
    });
  });

  it('ends the gesture on lost pointer capture', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 430, y: 310 } }));
    state = reduceCardPosition(state, { type: 'capture-lost', pointerId: 1 });
    expect(state).toEqual({
      position: { kind: 'free', x: 230, y: 160 },
      drag: { kind: 'idle' },
    });
  });

  it('ends the gesture on window blur while keeping the free position', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 430, y: 310 } }));
    state = reduceCardPosition(state, { type: 'window-blur' });
    expect(state).toEqual({
      position: { kind: 'free', x: 230, y: 160 },
      drag: { kind: 'idle' },
    });
  });

  it('ends the gesture when the main button is reported lost mid-move', () => {
    let state = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 404, y: 300 } }));
    state = reduceCardPosition(state, move({ pointer: { x: 500, y: 500 }, buttons: 0 }));
    expect(state).toEqual({
      position: { kind: 'anchored' },
      drag: { kind: 'idle' },
    });

    let dragging = reduceCardPosition(createCardPositionState(), down());
    dragging = reduceCardPosition(dragging, move({ pointer: { x: 430, y: 310 } }));
    dragging = reduceCardPosition(dragging, move({ pointer: { x: 500, y: 500 }, buttons: 0 }));
    expect(dragging).toEqual({
      position: { kind: 'free', x: 230, y: 160 },
      drag: { kind: 'idle' },
    });
  });

  it('ends lingering gestures on request start without changing the position mode', () => {
    let pending = reduceCardPosition(createCardPositionState(), down());
    pending = reduceCardPosition(pending, { type: 'request-started' });
    expect(pending).toEqual(createCardPositionState());

    let free = reduceCardPosition(createCardPositionState(), down());
    free = reduceCardPosition(free, move({ pointer: { x: 430, y: 310 } }));
    free = reduceCardPosition(free, { type: 'request-started' });
    expect(free).toEqual({
      position: { kind: 'free', x: 230, y: 160 },
      drag: { kind: 'idle' },
    });
  });

  it('keeps a legal free position unchanged on layout changes', () => {
    let state: CardPositionState = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 430, y: 310 } }));
    const before = state;
    state = reduceCardPosition(state, { type: 'layout-changed', cardSize: CARD, viewport: VIEWPORT });
    expect(state).toBe(before);
  });

  it('applies only the minimal per-axis correction on layout changes', () => {
    let state: CardPositionState = reduceCardPosition(createCardPositionState(), down());
    state = reduceCardPosition(state, move({ pointer: { x: 430, y: 310 } }));

    state = reduceCardPosition(state, {
      type: 'layout-changed',
      cardSize: { width: 200, height: 150 },
      viewport: { width: 420, height: 600 },
    });
    expect(state.position).toEqual({ kind: 'free', x: 212, y: 160 });

    state = reduceCardPosition(state, {
      type: 'layout-changed',
      cardSize: { width: 600, height: 150 },
      viewport: VIEWPORT,
    });
    expect(state.position).toEqual({ kind: 'free', x: 192, y: 160 });
  });

  it('leaves anchored cards untouched by layout changes', () => {
    const initial = createCardPositionState();
    expect(reduceCardPosition(initial, {
      type: 'layout-changed',
      cardSize: CARD,
      viewport: VIEWPORT,
    })).toBe(initial);
  });

  it('treats cancel-style events as idempotent when idle', () => {
    const initial = createCardPositionState();
    expect(reduceCardPosition(initial, { type: 'pointer-cancel', pointerId: 1 })).toBe(initial);
    expect(reduceCardPosition(initial, { type: 'capture-lost', pointerId: 1 })).toBe(initial);
    expect(reduceCardPosition(initial, { type: 'window-blur' })).toBe(initial);
    expect(reduceCardPosition(initial, { type: 'request-started' })).toBe(initial);
  });
});
