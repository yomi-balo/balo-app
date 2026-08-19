import { InfoNote } from '@/components/balo/section/section-states';

/**
 * A thin wrapper over the house `InfoNote` primitive — composition over a new abstraction.
 * No hooks, no handlers of its own, so it stays a server component even though it is only
 * ever rendered from inside the client tree.
 */
export function CalendarAppleNote(): React.JSX.Element {
  return (
    <InfoNote>
      On iCloud? Apple calendar sync is coming soon. In the meantime you can set your weekly hours
      by hand — clients can still book you.
    </InfoNote>
  );
}
