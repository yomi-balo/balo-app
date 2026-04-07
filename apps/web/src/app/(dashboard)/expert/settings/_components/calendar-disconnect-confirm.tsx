'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CalendarDisconnectConfirmProps {
  onCancel: () => void;
  onConfirm: () => void;
}

export function CalendarDisconnectConfirm({
  onCancel,
  onConfirm,
}: Readonly<CalendarDisconnectConfirmProps>): React.JSX.Element {
  return (
    <div className="border-warning/30 bg-warning/5 dark:bg-warning/10 flex items-center justify-between gap-4 border-b px-5 py-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="text-warning text-sm leading-relaxed">
          Disconnecting will stop syncing. Clients may see incorrect availability until you
          reconnect.
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button variant="outline" size="sm" onClick={onCancel} className="h-8 px-3 text-xs">
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} className="h-8 px-3 text-xs">
          Yes, disconnect
        </Button>
      </div>
    </div>
  );
}
