export class AirwallexAuthError extends Error {
  constructor(detail: string) {
    super(`Airwallex auth failed: ${detail}`);
    this.name = 'AirwallexAuthError';
  }
}

export class AirwallexApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly detail: string
  ) {
    super(`Airwallex API error ${status} at ${path}: ${detail}`);
    this.name = 'AirwallexApiError';
  }
}
