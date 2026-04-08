export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

export class CalendarNotConnectedError extends Error {
  constructor(expertProfileId: string) {
    super(`Expert ${expertProfileId} has no connected calendar`);
    this.name = 'CalendarNotConnectedError';
  }
}
