import type { RequestActivity } from './card-state';
import { constrainOverlayPosition } from './geometry';
import type { OverlayPoint, OverlaySize, ViewportSize } from './geometry';

export type PositionMode =
  | { kind: 'anchored' }
  | { kind: 'free'; x: number; y: number };

export type DragPhase =
  | { kind: 'idle' }
  | {
      kind: 'pending' | 'dragging';
      pointerId: number;
      pointerStart: OverlayPoint;
      cardStart: OverlayPoint;
    };

export interface CardPositionState {
  position: PositionMode;
  drag: DragPhase;
}

export type CardPositionEvent =
  | {
      type: 'pointer-down';
      pointerId: number;
      pointerType: string;
      isPrimary: boolean;
      button: number;
      pointer: OverlayPoint;
      card: OverlayPoint;
      requestActivity: RequestActivity;
    }
  | {
      type: 'pointer-move';
      pointerId: number;
      buttons: number;
      pointer: OverlayPoint;
      cardSize: OverlaySize;
      viewport: ViewportSize;
    }
  | {
      type: 'pointer-up';
      pointerId: number;
      buttons: number;
      pointer: OverlayPoint;
      cardSize: OverlaySize;
      viewport: ViewportSize;
    }
  | { type: 'pointer-cancel' | 'capture-lost'; pointerId: number }
  | { type: 'window-blur' }
  | { type: 'request-started' }
  | { type: 'layout-changed'; cardSize: OverlaySize; viewport: ViewportSize };

const DRAG_THRESHOLD_DISTANCE_SQUARED = 16;

export function createCardPositionState(): CardPositionState {
  return { position: { kind: 'anchored' }, drag: { kind: 'idle' } };
}

function endDrag(state: CardPositionState): CardPositionState {
  if (state.drag.kind === 'idle') {
    return state;
  }
  return { position: state.position, drag: { kind: 'idle' } };
}

export function reduceCardPosition(
  state: CardPositionState,
  event: CardPositionEvent,
): CardPositionState {
  switch (event.type) {
    case 'pointer-down': {
      if (
        state.drag.kind !== 'idle'
        || event.pointerType !== 'mouse'
        || !event.isPrimary
        || event.button !== 0
        || event.requestActivity !== 'stopped'
      ) {
        return state;
      }
      return {
        position: state.position,
        drag: {
          kind: 'pending',
          pointerId: event.pointerId,
          pointerStart: { ...event.pointer },
          cardStart: { ...event.card },
        },
      };
    }
    case 'pointer-move':
    case 'pointer-up': {
      if (state.drag.kind === 'idle' || state.drag.pointerId !== event.pointerId) {
        return state;
      }
      if (event.type === 'pointer-move' && (event.buttons & 1) === 0) {
        return endDrag(state);
      }
      if (state.drag.kind === 'pending') {
        if (event.type === 'pointer-up') {
          return endDrag(state);
        }
        const pendingDx = event.pointer.x - state.drag.pointerStart.x;
        const pendingDy = event.pointer.y - state.drag.pointerStart.y;
        if (pendingDx * pendingDx + pendingDy * pendingDy <= DRAG_THRESHOLD_DISTANCE_SQUARED) {
          return state;
        }
      }

      const dx = event.pointer.x - state.drag.pointerStart.x;
      const dy = event.pointer.y - state.drag.pointerStart.y;
      const constrained = constrainOverlayPosition(
        { x: state.drag.cardStart.x + dx, y: state.drag.cardStart.y + dy },
        event.cardSize,
        event.viewport,
      );
      return {
        position: { kind: 'free', x: constrained.x, y: constrained.y },
        drag: event.type === 'pointer-up'
          ? { kind: 'idle' }
          : {
              kind: 'dragging',
              pointerId: state.drag.pointerId,
              pointerStart: { ...state.drag.pointerStart },
              cardStart: { ...state.drag.cardStart },
            },
      };
    }
    case 'pointer-cancel':
    case 'capture-lost': {
      if (state.drag.kind === 'idle' || state.drag.pointerId !== event.pointerId) {
        return state;
      }
      return endDrag(state);
    }
    case 'window-blur':
    case 'request-started': {
      return endDrag(state);
    }
    case 'layout-changed': {
      if (state.position.kind !== 'free') {
        return state;
      }
      const constrained = constrainOverlayPosition(
        { x: state.position.x, y: state.position.y },
        event.cardSize,
        event.viewport,
      );
      if (constrained.x === state.position.x && constrained.y === state.position.y) {
        return state;
      }
      return { position: { kind: 'free', ...constrained }, drag: state.drag };
    }
  }
}
