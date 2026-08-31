import type { RequestActivity } from './card-state';
import {
  constrainOverlaySize,
  exceedsPointerDragThreshold,
} from './geometry';
import type { OverlayPoint, OverlaySize, ViewportSize } from './geometry';

export type SizeMode =
  | { kind: 'auto' }
  | { kind: 'user'; target: OverlaySize };

export type ResizePhase =
  | { kind: 'idle' }
  | {
      kind: 'pending' | 'resizing';
      pointerId: number;
      pointerStart: OverlayPoint;
      sizeStart: OverlaySize;
    };

export interface CardSizeState {
  mode: SizeMode;
  resize: ResizePhase;
}

export type CardSizeEvent =
  | {
      type: 'pointer-down';
      pointerId: number;
      pointerType: string;
      isPrimary: boolean;
      button: number;
      pointer: OverlayPoint;
      cardSize: OverlaySize;
      requestActivity: RequestActivity;
    }
  | {
      type: 'pointer-move';
      pointerId: number;
      buttons: number;
      pointer: OverlayPoint;
      viewport: ViewportSize;
    }
  | {
      type: 'pointer-up';
      pointerId: number;
      buttons: number;
      pointer: OverlayPoint;
      viewport: ViewportSize;
    }
  | { type: 'pointer-cancel' | 'capture-lost'; pointerId: number }
  | { type: 'window-blur' }
  | { type: 'request-started' };

export function createCardSizeState(): CardSizeState {
  return { mode: { kind: 'auto' }, resize: { kind: 'idle' } };
}

function endResize(state: CardSizeState): CardSizeState {
  if (state.resize.kind === 'idle') {
    return state;
  }
  return { mode: state.mode, resize: { kind: 'idle' } };
}

function applyResizePoint(
  state: CardSizeState,
  pointer: OverlayPoint,
  viewport: ViewportSize,
  finish: boolean,
): CardSizeState {
  if (state.resize.kind === 'idle') {
    return state;
  }

  const dx = pointer.x - state.resize.pointerStart.x;
  const dy = pointer.y - state.resize.pointerStart.y;
  const target = constrainOverlaySize({
    width: state.resize.sizeStart.width + dx,
    height: state.resize.sizeStart.height + dy,
  }, viewport);

  return {
    mode: { kind: 'user', target },
    resize: finish
      ? { kind: 'idle' }
      : {
          kind: 'resizing',
          pointerId: state.resize.pointerId,
          pointerStart: { ...state.resize.pointerStart },
          sizeStart: { ...state.resize.sizeStart },
        },
  };
}

export function reduceCardSize(state: CardSizeState, event: CardSizeEvent): CardSizeState {
  switch (event.type) {
    case 'pointer-down': {
      if (
        state.resize.kind !== 'idle'
        || event.pointerType !== 'mouse'
        || !event.isPrimary
        || event.button !== 0
        || event.requestActivity !== 'stopped'
      ) {
        return state;
      }

      return {
        mode: state.mode,
        resize: {
          kind: 'pending',
          pointerId: event.pointerId,
          pointerStart: { ...event.pointer },
          sizeStart: { ...event.cardSize },
        },
      };
    }
    case 'pointer-move':
    case 'pointer-up': {
      if (state.resize.kind === 'idle' || state.resize.pointerId !== event.pointerId) {
        return state;
      }

      if (event.type === 'pointer-move' && (event.buttons & 1) === 0) {
        return endResize(state);
      }

      if (state.resize.kind === 'pending') {
        if (event.type === 'pointer-up') {
          return endResize(state);
        }
        if (!exceedsPointerDragThreshold(state.resize.pointerStart, event.pointer)) {
          return state;
        }
      }

      return applyResizePoint(
        state,
        event.pointer,
        event.viewport,
        event.type === 'pointer-up',
      );
    }
    case 'pointer-cancel':
    case 'capture-lost': {
      if (state.resize.kind === 'idle' || state.resize.pointerId !== event.pointerId) {
        return state;
      }
      return endResize(state);
    }
    case 'window-blur':
    case 'request-started':
      return endResize(state);
  }
}

export function resolveUserCardSize(
  state: CardSizeState,
  viewport: ViewportSize,
): OverlaySize | null {
  return state.mode.kind === 'user'
    ? constrainOverlaySize(state.mode.target, viewport)
    : null;
}
