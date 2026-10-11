export interface PointerData {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
}

export function pointerEvent(type: string, data: PointerData = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: data.pointerId ?? 1 },
    pointerType: { configurable: true, value: data.pointerType ?? 'mouse' },
    isPrimary: { configurable: true, value: data.isPrimary ?? true },
    button: { configurable: true, value: data.button ?? 0 },
    buttons: { configurable: true, value: data.buttons ?? 1 },
    clientX: { configurable: true, value: data.clientX ?? 400 },
    clientY: { configurable: true, value: data.clientY ?? 300 },
  });
  return event;
}
