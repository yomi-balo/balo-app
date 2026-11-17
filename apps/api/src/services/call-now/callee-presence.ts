/**
 * BAL-649 (decision 4) — THE CALLEE-PRESENCE PORT.
 *
 * "Is this person online right now?" decides whether the 8 am–8 pm rule applies to a client's
 * ring. There is no real presence source yet, so the shipped default answers `false` for
 * everyone: every client-initiated ring is then subject to the expert's local call hours, which
 * is the conservative reading. The port exists so the gates take it as a parameter, tests can
 * flip it, and the real source (a follow-up) is a one-line swap here.
 */
export interface CalleePresence {
  isOnline(userId: string): Promise<boolean>;
}

/** Nobody is ever online. The safe default until a real presence source exists. */
export const offlineCalleePresence: CalleePresence = {
  isOnline: () => Promise.resolve(false),
};
