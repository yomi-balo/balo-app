/**
 * BAL-435 — the chrome-free, full-bleed shell for the in-call surface.
 *
 * ⚠⚠ **A TOP-LEVEL ROUTE GROUP THAT BYPASSES `(dashboard)` MUST RESTATE THE SESSION-DRIFT GATE —
 * AND THIS ONE RESTATES IT IN THE PAGE, NOT HERE.**
 *
 * `(dashboard)/layout.tsx` runs `checkSessionDrift()` → `/api/auth/session-sync?returnTo=…`
 * before anything renders. This group exists precisely so the call does NOT inherit that layout
 * (no `TopNav`, no `Sidebar`, no checklist fetch, no `companiesRepository` read — a call surface
 * with app chrome around it looks like a widget, not a call). The gate itself is NOT optional:
 * `postMemberJoin` forwards `session.accessToken` as a Bearer to `apps/api`, so a DRIFTED session
 * carries a STALE access token, the member join 401s, and a perfectly valid participant is shown
 * "This meeting isn't available to join" at the moment they are trying to get into a paid call.
 *
 * ⚠⚠ IT MOVED TO `meetings/[meetingId]/call/page.tsx` BECAUSE `returnTo` NEEDS THE `meetingId`,
 * AND A LAYOUT CANNOT SEE A CHILD SEGMENT'S PARAMS. The version that lived here read
 * `headers().get('x-invoke-path')` — a header that **does not exist in Next 16** — so the value
 * was always `/dashboard` and a drifted member was bounced away from the call they were entering
 * rather than returned to it. A dead header read is worse than no gate: it looks like one.
 *
 * ⚠ ANY FUTURE ROUTE ADDED TO THIS GROUP MUST RUN `checkSessionDrift()` IN ITS OWN PAGE. There is
 * deliberately no layout-level gate to inherit.
 *
 * ⚠ `h-dvh`, NEVER `h-screen` — mobile browser chrome makes `100vh` taller than the visible
 * viewport, which pushes the toolbar (and the Leave button) off-screen.
 *
 * ⚠ THE FRAME'S OWN `.dark` CLASS IS ON `meeting-frame-impl.tsx`, not here, so the notice cards
 * this route can render before the frame mounts stay in the viewer's own theme.
 */
export default function CallLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <div className="bg-background text-foreground h-dvh overflow-hidden">{children}</div>;
}
