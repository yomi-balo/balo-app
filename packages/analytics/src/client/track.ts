import { analytics } from './client';
import type { AllEvents, EventName } from '../types';

/**
 * Type-safe event tracking wrapper.
 * The compiler enforces that event names are known constants and
 * properties match the interface defined for that event.
 */
export function track<E extends EventName>(event: E, properties: AllEvents[E]): void {
  if (typeof window === 'undefined') return;
  analytics.track(event, properties as Record<string, unknown>);
}
