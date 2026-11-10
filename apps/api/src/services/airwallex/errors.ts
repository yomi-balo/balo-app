export class AirwallexAuthError extends Error {
  constructor(
    public readonly detail: string,
    public readonly status?: number
  ) {
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

export class AirwallexConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Airwallex is not configured: missing ${missing.join(', ')}`);
    this.name = 'AirwallexConfigError';
  }
}
