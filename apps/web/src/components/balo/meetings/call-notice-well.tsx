interface CallNoticeWellProps {
  readonly children: React.ReactNode;
}

/**
 * The centred well a notice card renders in when it takes the place of the call stage — the
 * "Connecting…" card while the call chunk downloads, the grant-rejected card, and every pre-call
 * notice on the member route.
 *
 * The cards themselves are only `mx-auto max-w-md`. On the full-viewport call shells (the member
 * `(call)` layout, the guest `GuestCallViewport`) that left them pinned to the top edge, and edge
 * to edge on a phone; this supplies the vertical centring and the outer margin.
 */
export function CallNoticeWell({ children }: Readonly<CallNoticeWellProps>): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4 py-8">
      {children}
    </div>
  );
}
