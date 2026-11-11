// A vendor error body is unbounded, so anything logged or reported from it is capped.
export const AIRWALLEX_DETAIL_LIMIT = 2048;

export function truncateAirwallexDetail(detail: string): string {
  return detail.slice(0, AIRWALLEX_DETAIL_LIMIT);
}

export class AirwallexAuthError extends Error {
  constructor(
    public readonly detail: string,
    public readonly status?: number
  ) {
    super(`Airwallex auth failed: ${truncateAirwallexDetail(detail)}`);
    this.name = 'AirwallexAuthError';
  }
}

export class AirwallexApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly detail: string
  ) {
    super(`Airwallex API error ${status} at ${path}: ${truncateAirwallexDetail(detail)}`);
    this.name = 'AirwallexApiError';
  }
}

export class AirwallexConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Airwallex is not configured: missing ${missing.join(', ')}`);
    this.name = 'AirwallexConfigError';
  }
}
