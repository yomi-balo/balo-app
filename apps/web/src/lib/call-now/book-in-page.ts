/**
 * Whether a viewer can book the expert from inside the case page: the client side of a still-open
 * case whose expert has a public profile to read availability from. The case surface, the confirm
 * dialog's "Book a time" and the caller's call room all ask this one question, so they cannot
 * disagree about whether the booking has somewhere to go.
 */
export function canBookInPage(input: {
  lens: 'client' | 'expert';
  isOpen: boolean;
  hasPublicProfile: boolean;
}): boolean {
  return input.lens === 'client' && input.isOpen && input.hasPublicProfile;
}
