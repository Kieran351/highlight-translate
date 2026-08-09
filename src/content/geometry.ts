export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface OverlayPosition {
  x: number;
  y: number;
  visible: boolean;
}

interface SelectionEndpointSource {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

export interface SelectionEndpoint {
  node: Node;
  offset: number;
}

const VIEWPORT_MARGIN = 8;

export function endpointFromSelection(selection: SelectionEndpointSource): SelectionEndpoint | null {
  return selection.focusNode
    ? { node: selection.focusNode, offset: selection.focusOffset }
    : null;
}

export function getRangeEndpointRect(range: Range): DOMRect {
  const endpoint = range.cloneRange();
  endpoint.collapse(false);
  const caretRect = endpoint.getBoundingClientRect();

  if (caretRect.width > 0 || caretRect.height > 0) {
    return caretRect;
  }

  const rects = range.getClientRects();
  return rects.item(rects.length - 1) ?? range.getBoundingClientRect();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeOverlay(
  anchor: AnchorRect,
  overlay: OverlaySize,
  viewport: ViewportSize,
  gap: number,
): OverlayPosition {
  const visible = anchor.bottom >= 0
    && anchor.top <= viewport.height
    && anchor.right >= 0
    && anchor.left <= viewport.width;

  let x = anchor.right + gap;
  if (x + overlay.width > viewport.width - VIEWPORT_MARGIN) {
    x = anchor.left - gap - overlay.width;
  }

  let y = anchor.bottom + gap;
  if (y + overlay.height > viewport.height - VIEWPORT_MARGIN) {
    y = anchor.top - gap - overlay.height;
  }

  return {
    x: clamp(x, VIEWPORT_MARGIN, viewport.width - overlay.width - VIEWPORT_MARGIN),
    y: clamp(y, VIEWPORT_MARGIN, viewport.height - overlay.height - VIEWPORT_MARGIN),
    visible,
  };
}
