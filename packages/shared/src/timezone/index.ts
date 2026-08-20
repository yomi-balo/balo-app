/**
 * Timezone-to-country mapping and helpers.
 *
 * Used by:
 * - updateTimezoneAction: derive country/countryCode when user's timezone is saved
 * - ExpertCard: extract city name for location display
 */

// ── IANA timezone → country mapping ─────────────────────────────

export const TIMEZONE_TO_COUNTRY: Record<string, { country: string; countryCode: string }> = {
  // Australia
  'Australia/Sydney': { country: 'Australia', countryCode: 'AU' },
  'Australia/Melbourne': { country: 'Australia', countryCode: 'AU' },
  'Australia/Brisbane': { country: 'Australia', countryCode: 'AU' },
  'Australia/Perth': { country: 'Australia', countryCode: 'AU' },
  'Australia/Adelaide': { country: 'Australia', countryCode: 'AU' },
  'Australia/Hobart': { country: 'Australia', countryCode: 'AU' },
  'Australia/Darwin': { country: 'Australia', countryCode: 'AU' },
  'Australia/Lord_Howe': { country: 'Australia', countryCode: 'AU' },
  'Australia/Broken_Hill': { country: 'Australia', countryCode: 'AU' },
  'Australia/Lindeman': { country: 'Australia', countryCode: 'AU' },
  'Australia/Eucla': { country: 'Australia', countryCode: 'AU' },

  // New Zealand
  'Pacific/Auckland': { country: 'New Zealand', countryCode: 'NZ' },
  'Pacific/Chatham': { country: 'New Zealand', countryCode: 'NZ' },

  // United States
  'America/New_York': { country: 'United States', countryCode: 'US' },
  'America/Chicago': { country: 'United States', countryCode: 'US' },
  'America/Denver': { country: 'United States', countryCode: 'US' },
  'America/Los_Angeles': { country: 'United States', countryCode: 'US' },
  'America/Phoenix': { country: 'United States', countryCode: 'US' },
  'America/Anchorage': { country: 'United States', countryCode: 'US' },
  'America/Boise': { country: 'United States', countryCode: 'US' },
  'America/Detroit': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Indianapolis': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Knox': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Marengo': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Petersburg': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Tell_City': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Vevay': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Vincennes': { country: 'United States', countryCode: 'US' },
  'America/Indiana/Winamac': { country: 'United States', countryCode: 'US' },
  'America/Kentucky/Louisville': { country: 'United States', countryCode: 'US' },
  'America/Kentucky/Monticello': { country: 'United States', countryCode: 'US' },
  'America/North_Dakota/Beulah': { country: 'United States', countryCode: 'US' },
  'America/North_Dakota/Center': { country: 'United States', countryCode: 'US' },
  'America/North_Dakota/New_Salem': { country: 'United States', countryCode: 'US' },
  'America/Adak': { country: 'United States', countryCode: 'US' },
  'America/Juneau': { country: 'United States', countryCode: 'US' },
  'America/Sitka': { country: 'United States', countryCode: 'US' },
  'America/Yakutat': { country: 'United States', countryCode: 'US' },
  'America/Nome': { country: 'United States', countryCode: 'US' },
  'America/Metlakatla': { country: 'United States', countryCode: 'US' },
  'Pacific/Honolulu': { country: 'United States', countryCode: 'US' },

  // Canada
  'America/Toronto': { country: 'Canada', countryCode: 'CA' },
  'America/Vancouver': { country: 'Canada', countryCode: 'CA' },
  'America/Edmonton': { country: 'Canada', countryCode: 'CA' },
  'America/Winnipeg': { country: 'Canada', countryCode: 'CA' },
  'America/Halifax': { country: 'Canada', countryCode: 'CA' },
  'America/St_Johns': { country: 'Canada', countryCode: 'CA' },
  'America/Regina': { country: 'Canada', countryCode: 'CA' },
  'America/Moncton': { country: 'Canada', countryCode: 'CA' },
  'America/Yellowknife': { country: 'Canada', countryCode: 'CA' },
  'America/Whitehorse': { country: 'Canada', countryCode: 'CA' },
  'America/Iqaluit': { country: 'Canada', countryCode: 'CA' },
  'America/Dawson': { country: 'Canada', countryCode: 'CA' },
  'America/Dawson_Creek': { country: 'Canada', countryCode: 'CA' },
  'America/Fort_Nelson': { country: 'Canada', countryCode: 'CA' },
  'America/Glace_Bay': { country: 'Canada', countryCode: 'CA' },
  'America/Goose_Bay': { country: 'Canada', countryCode: 'CA' },
  'America/Rankin_Inlet': { country: 'Canada', countryCode: 'CA' },
  'America/Resolute': { country: 'Canada', countryCode: 'CA' },
  'America/Swift_Current': { country: 'Canada', countryCode: 'CA' },

  // United Kingdom
  'Europe/London': { country: 'United Kingdom', countryCode: 'GB' },

  // Ireland
  'Europe/Dublin': { country: 'Ireland', countryCode: 'IE' },

  // France
  'Europe/Paris': { country: 'France', countryCode: 'FR' },

  // Germany
  'Europe/Berlin': { country: 'Germany', countryCode: 'DE' },

  // Italy
  'Europe/Rome': { country: 'Italy', countryCode: 'IT' },

  // Spain
  'Europe/Madrid': { country: 'Spain', countryCode: 'ES' },

  // Netherlands
  'Europe/Amsterdam': { country: 'Netherlands', countryCode: 'NL' },

  // Belgium
  'Europe/Brussels': { country: 'Belgium', countryCode: 'BE' },

  // Switzerland
  'Europe/Zurich': { country: 'Switzerland', countryCode: 'CH' },

  // Austria
  'Europe/Vienna': { country: 'Austria', countryCode: 'AT' },

  // Sweden
  'Europe/Stockholm': { country: 'Sweden', countryCode: 'SE' },

  // Norway
  'Europe/Oslo': { country: 'Norway', countryCode: 'NO' },

  // Denmark
  'Europe/Copenhagen': { country: 'Denmark', countryCode: 'DK' },

  // Finland
  'Europe/Helsinki': { country: 'Finland', countryCode: 'FI' },

  // Poland
  'Europe/Warsaw': { country: 'Poland', countryCode: 'PL' },

  // Czech Republic
  'Europe/Prague': { country: 'Czech Republic', countryCode: 'CZ' },

  // Romania
  'Europe/Bucharest': { country: 'Romania', countryCode: 'RO' },

  // Hungary
  'Europe/Budapest': { country: 'Hungary', countryCode: 'HU' },

  // Portugal
  'Europe/Lisbon': { country: 'Portugal', countryCode: 'PT' },

  // Greece
  'Europe/Athens': { country: 'Greece', countryCode: 'GR' },

  // Turkey
  'Europe/Istanbul': { country: 'Turkey', countryCode: 'TR' },

  // Japan
  'Asia/Tokyo': { country: 'Japan', countryCode: 'JP' },

  // South Korea
  'Asia/Seoul': { country: 'South Korea', countryCode: 'KR' },

  // China
  'Asia/Shanghai': { country: 'China', countryCode: 'CN' },
  'Asia/Urumqi': { country: 'China', countryCode: 'CN' },

  // Hong Kong
  'Asia/Hong_Kong': { country: 'Hong Kong', countryCode: 'HK' },

  // Taiwan
  'Asia/Taipei': { country: 'Taiwan', countryCode: 'TW' },

  // Singapore
  'Asia/Singapore': { country: 'Singapore', countryCode: 'SG' },

  // India
  'Asia/Kolkata': { country: 'India', countryCode: 'IN' },
  'Asia/Calcutta': { country: 'India', countryCode: 'IN' },

  // United Arab Emirates
  'Asia/Dubai': { country: 'United Arab Emirates', countryCode: 'AE' },

  // Saudi Arabia
  'Asia/Riyadh': { country: 'Saudi Arabia', countryCode: 'SA' },

  // Thailand
  'Asia/Bangkok': { country: 'Thailand', countryCode: 'TH' },

  // Indonesia
  'Asia/Jakarta': { country: 'Indonesia', countryCode: 'ID' },
  'Asia/Makassar': { country: 'Indonesia', countryCode: 'ID' },
  'Asia/Jayapura': { country: 'Indonesia', countryCode: 'ID' },
  'Asia/Pontianak': { country: 'Indonesia', countryCode: 'ID' },

  // Philippines
  'Asia/Manila': { country: 'Philippines', countryCode: 'PH' },

  // Malaysia
  'Asia/Kuala_Lumpur': { country: 'Malaysia', countryCode: 'MY' },
  'Asia/Kuching': { country: 'Malaysia', countryCode: 'MY' },

  // Pakistan
  'Asia/Karachi': { country: 'Pakistan', countryCode: 'PK' },

  // Bangladesh
  'Asia/Dhaka': { country: 'Bangladesh', countryCode: 'BD' },

  // Sri Lanka
  'Asia/Colombo': { country: 'Sri Lanka', countryCode: 'LK' },

  // Vietnam
  'Asia/Ho_Chi_Minh': { country: 'Vietnam', countryCode: 'VN' },
  'Asia/Saigon': { country: 'Vietnam', countryCode: 'VN' },

  // Israel
  'Asia/Jerusalem': { country: 'Israel', countryCode: 'IL' },

  // Qatar
  'Asia/Qatar': { country: 'Qatar', countryCode: 'QA' },

  // Kuwait
  'Asia/Kuwait': { country: 'Kuwait', countryCode: 'KW' },

  // Bahrain
  'Asia/Bahrain': { country: 'Bahrain', countryCode: 'BH' },

  // Oman
  'Asia/Muscat': { country: 'Oman', countryCode: 'OM' },

  // Myanmar
  'Asia/Yangon': { country: 'Myanmar', countryCode: 'MM' },

  // Cambodia
  'Asia/Phnom_Penh': { country: 'Cambodia', countryCode: 'KH' },

  // Nepal
  'Asia/Kathmandu': { country: 'Nepal', countryCode: 'NP' },

  // South Africa
  'Africa/Johannesburg': { country: 'South Africa', countryCode: 'ZA' },

  // Nigeria
  'Africa/Lagos': { country: 'Nigeria', countryCode: 'NG' },

  // Egypt
  'Africa/Cairo': { country: 'Egypt', countryCode: 'EG' },

  // Kenya
  'Africa/Nairobi': { country: 'Kenya', countryCode: 'KE' },

  // Morocco
  'Africa/Casablanca': { country: 'Morocco', countryCode: 'MA' },

  // Ghana
  'Africa/Accra': { country: 'Ghana', countryCode: 'GH' },

  // Tanzania
  'Africa/Dar_es_Salaam': { country: 'Tanzania', countryCode: 'TZ' },

  // Ethiopia
  'Africa/Addis_Ababa': { country: 'Ethiopia', countryCode: 'ET' },

  // Brazil
  'America/Sao_Paulo': { country: 'Brazil', countryCode: 'BR' },
  'America/Fortaleza': { country: 'Brazil', countryCode: 'BR' },
  'America/Recife': { country: 'Brazil', countryCode: 'BR' },
  'America/Bahia': { country: 'Brazil', countryCode: 'BR' },
  'America/Belem': { country: 'Brazil', countryCode: 'BR' },
  'America/Manaus': { country: 'Brazil', countryCode: 'BR' },
  'America/Cuiaba': { country: 'Brazil', countryCode: 'BR' },
  'America/Campo_Grande': { country: 'Brazil', countryCode: 'BR' },

  // Argentina
  'America/Argentina/Buenos_Aires': { country: 'Argentina', countryCode: 'AR' },
  'America/Argentina/Cordoba': { country: 'Argentina', countryCode: 'AR' },
  'America/Argentina/Mendoza': { country: 'Argentina', countryCode: 'AR' },

  // Mexico
  'America/Mexico_City': { country: 'Mexico', countryCode: 'MX' },
  'America/Cancun': { country: 'Mexico', countryCode: 'MX' },
  'America/Monterrey': { country: 'Mexico', countryCode: 'MX' },
  'America/Tijuana': { country: 'Mexico', countryCode: 'MX' },
  'America/Hermosillo': { country: 'Mexico', countryCode: 'MX' },
  'America/Chihuahua': { country: 'Mexico', countryCode: 'MX' },
  'America/Merida': { country: 'Mexico', countryCode: 'MX' },

  // Colombia
  'America/Bogota': { country: 'Colombia', countryCode: 'CO' },

  // Peru
  'America/Lima': { country: 'Peru', countryCode: 'PE' },

  // Chile
  'America/Santiago': { country: 'Chile', countryCode: 'CL' },

  // Venezuela
  'America/Caracas': { country: 'Venezuela', countryCode: 'VE' },

  // Ecuador
  'America/Guayaquil': { country: 'Ecuador', countryCode: 'EC' },

  // Bolivia
  'America/La_Paz': { country: 'Bolivia', countryCode: 'BO' },

  // Paraguay
  'America/Asuncion': { country: 'Paraguay', countryCode: 'PY' },

  // Uruguay
  'America/Montevideo': { country: 'Uruguay', countryCode: 'UY' },

  // Costa Rica
  'America/Costa_Rica': { country: 'Costa Rica', countryCode: 'CR' },

  // Panama
  'America/Panama': { country: 'Panama', countryCode: 'PA' },

  // Jamaica
  'America/Jamaica': { country: 'Jamaica', countryCode: 'JM' },

  // Dominican Republic
  'America/Santo_Domingo': { country: 'Dominican Republic', countryCode: 'DO' },

  // Guatemala
  'America/Guatemala': { country: 'Guatemala', countryCode: 'GT' },

  // Honduras
  'America/Tegucigalpa': { country: 'Honduras', countryCode: 'HN' },

  // El Salvador
  'America/El_Salvador': { country: 'El Salvador', countryCode: 'SV' },

  // Nicaragua
  'America/Managua': { country: 'Nicaragua', countryCode: 'NI' },

  // Cuba
  'America/Havana': { country: 'Cuba', countryCode: 'CU' },

  // Puerto Rico
  'America/Puerto_Rico': { country: 'Puerto Rico', countryCode: 'PR' },

  // Fiji
  'Pacific/Fiji': { country: 'Fiji', countryCode: 'FJ' },

  // Guam
  'Pacific/Guam': { country: 'Guam', countryCode: 'GU' },

  // Maldives
  'Indian/Maldives': { country: 'Maldives', countryCode: 'MV' },

  // Mauritius
  'Indian/Mauritius': { country: 'Mauritius', countryCode: 'MU' },

  // Russia (major zones)
  'Europe/Moscow': { country: 'Russia', countryCode: 'RU' },
  'Europe/Kaliningrad': { country: 'Russia', countryCode: 'RU' },
  'Asia/Vladivostok': { country: 'Russia', countryCode: 'RU' },
  'Asia/Yekaterinburg': { country: 'Russia', countryCode: 'RU' },
  'Asia/Novosibirsk': { country: 'Russia', countryCode: 'RU' },
  'Asia/Krasnoyarsk': { country: 'Russia', countryCode: 'RU' },
  'Asia/Irkutsk': { country: 'Russia', countryCode: 'RU' },
  'Asia/Yakutsk': { country: 'Russia', countryCode: 'RU' },
  'Asia/Magadan': { country: 'Russia', countryCode: 'RU' },
  'Asia/Kamchatka': { country: 'Russia', countryCode: 'RU' },

  // Ukraine
  'Europe/Kyiv': { country: 'Ukraine', countryCode: 'UA' },

  // Georgia (country)
  'Asia/Tbilisi': { country: 'Georgia', countryCode: 'GE' },

  // Armenia
  'Asia/Yerevan': { country: 'Armenia', countryCode: 'AM' },

  // Azerbaijan
  'Asia/Baku': { country: 'Azerbaijan', countryCode: 'AZ' },

  // Serbia
  'Europe/Belgrade': { country: 'Serbia', countryCode: 'RS' },

  // Croatia
  'Europe/Zagreb': { country: 'Croatia', countryCode: 'HR' },

  // Bulgaria
  'Europe/Sofia': { country: 'Bulgaria', countryCode: 'BG' },

  // Slovakia
  'Europe/Bratislava': { country: 'Slovakia', countryCode: 'SK' },

  // Slovenia
  'Europe/Ljubljana': { country: 'Slovenia', countryCode: 'SI' },

  // Estonia
  'Europe/Tallinn': { country: 'Estonia', countryCode: 'EE' },

  // Latvia
  'Europe/Riga': { country: 'Latvia', countryCode: 'LV' },

  // Lithuania
  'Europe/Vilnius': { country: 'Lithuania', countryCode: 'LT' },

  // Iceland
  'Atlantic/Reykjavik': { country: 'Iceland', countryCode: 'IS' },

  // Malta
  'Europe/Malta': { country: 'Malta', countryCode: 'MT' },

  // Cyprus
  'Asia/Nicosia': { country: 'Cyprus', countryCode: 'CY' },

  // Luxembourg
  'Europe/Luxembourg': { country: 'Luxembourg', countryCode: 'LU' },

  // Monaco
  'Europe/Monaco': { country: 'Monaco', countryCode: 'MC' },

  // Atlantic territories
  'Atlantic/Canary': { country: 'Spain', countryCode: 'ES' },
  'Atlantic/Madeira': { country: 'Portugal', countryCode: 'PT' },

  // US territories
  'Pacific/Midway': { country: 'United States', countryCode: 'US' },

  // Australian territories
  'Indian/Christmas': { country: 'Australia', countryCode: 'AU' },
  'Indian/Cocos': { country: 'Australia', countryCode: 'AU' },
  'Pacific/Norfolk': { country: 'Australia', countryCode: 'AU' },

  // American Samoa
  'Pacific/Pago_Pago': { country: 'American Samoa', countryCode: 'AS' },
};

/**
 * Derive country and countryCode from an IANA timezone string.
 * Returns null if the timezone is not in the mapping.
 */
export function deriveCountryFromTimezone(
  timezone: string
): { country: string; countryCode: string } | null {
  return TIMEZONE_TO_COUNTRY[timezone] ?? null;
}

/**
 * Extract the city name from an IANA timezone string (e.g. "Australia/Sydney" -> "Sydney").
 * Handles nested paths like "America/Indiana/Indianapolis" -> "Indianapolis".
 * Replaces underscores with spaces.
 * Returns null for UTC or invalid formats.
 */
export function extractCityFromTimezone(timezone: string | null | undefined): string | null {
  if (!timezone || timezone === 'UTC') return null;
  const parts = timezone.split('/');
  const city = parts.at(-1);
  if (!city) return null;
  return city.replaceAll('_', ' ');
}

// ── Timezone validity ───────────────────────────────────────────
//
// `Intl.supportedValuesOf('timeZone')` OMITS 'UTC' in Node, yet 'UTC' is the
// `expert_profiles.timezone` column default (and the system default), so a fresh
// expert who never changes their timezone must still validate. Built ONCE at module
// scope — `supportedValuesOf` allocates a ~400-entry array on every call.

const VALID_TIMEZONES = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/**
 * True when `tz` is an IANA timezone identifier this platform accepts — any zone
 * from `Intl.supportedValuesOf('timeZone')` plus the special-cased `'UTC'` (which
 * Node omits from that list). Empty strings and unknown zones are false. Shared by
 * the API and web validation layers so the valid-zone set is defined in one place.
 */
export function isValidTimezone(tz: string): boolean {
  return VALID_TIMEZONES.has(tz);
}

// ── DST spring-forward gap detection (pure, Intl-only) ──────────────
//
// Wall-clock availability rules (BAL-234) are timezone-agnostic. On a spring-forward
// (DST) transition, a local wall-clock interval is skipped entirely — e.g. clocks jump
// 02:00 → 03:00, so any rule landing in [02:00, 03:00) does not exist that day. This
// surfaces a NON-BLOCKING warning in the schedule editor. The server-side resolver
// (date-fns-tz) remains the authoritative, lenient interpreter; these helpers only warn.
//
// Intl-only so the ONE implementation runs unchanged in the browser and the API without
// adding a date library to the web app (@balo/shared has no date-fns).

/** A skipped wall-clock interval caused by a DST spring-forward transition. */
export interface SpringForwardGap {
  /** ISO date (YYYY-MM-DD, local to the timezone) on which the gap occurs. */
  dateISO: string;
  /** JS day-of-week of that local date (0=Sun … 6=Sat). */
  dayOfWeek: number;
  /** Local minute-of-day the gap starts, inclusive (e.g. 120 for 02:00). */
  gapStartMinutes: number;
  /** Local minute-of-day the gap ends, exclusive (e.g. 180 for 03:00). */
  gapEndMinutes: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Scan horizon (~13 months) — v1 warns on the single upcoming transition only. */
const SCAN_DAYS = 400;

/**
 * One `Intl.DateTimeFormat` per timezone, reused for the process lifetime. Every
 * formatter option here is a compile-time constant, so the IANA zone string is a
 * complete cache key. `formatToParts(instant)` takes the instant per-call and does
 * not mutate the formatter, so sharing one instance per zone is safe — and it
 * collapses the ~400 constructions per spring-forward scan (which builds one
 * formatter per sampled day) down to one per distinct zone.
 */
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of an instant as observed in `timeZone`. */
function tzWallClock(
  timeZone: string,
  instant: Date
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = wallClockFormatter(timeZone);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of formatter.formatToParts(instant)) {
    const value = Number(part.value);
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value === 24 ? 0 : value;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  return { year, month, day, hour, minute, second };
}

/** Offset (minutes) that `timeZone` is ahead of UTC at `instant`. */
function tzOffsetMinutes(timeZone: string, instant: Date): number {
  const wall = tzWallClock(timeZone, instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - instant.getTime()) / MS_PER_MINUTE);
}

/** UTC parts of a raw millisecond value (used to read a wall-clock built as UTC). */
function utcParts(ms: number): {
  year: number;
  month: number;
  day: number;
  dow: number;
  minuteOfDay: number;
} {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    dow: date.getUTCDay(),
    minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Binary-search the spring-forward transition between two 24h-apart samples. */
function pinpointGap(timeZone: string, loInstant: Date, hiInstant: Date): SpringForwardGap {
  const before = tzOffsetMinutes(timeZone, loInstant);
  const after = tzOffsetMinutes(timeZone, hiInstant);
  let loMs = loInstant.getTime();
  let hiMs = hiInstant.getTime();
  while (hiMs - loMs > MS_PER_MINUTE) {
    const midMs = loMs + Math.floor((hiMs - loMs) / 2);
    if (tzOffsetMinutes(timeZone, new Date(midMs)) <= before) {
      loMs = midMs;
    } else {
      hiMs = midMs;
    }
  }
  // Wall-clock the skipped interval starts at = the transition instant read with the OLD offset.
  const wall = utcParts(hiMs + before * MS_PER_MINUTE);
  const gapStartMinutes = wall.minuteOfDay;
  return {
    dateISO: `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`,
    dayOfWeek: wall.dow,
    gapStartMinutes,
    gapEndMinutes: gapStartMinutes + (after - before),
  };
}

/**
 * The timezone's next spring-forward (DST) gap on/after `from`, or null when the zone
 * has no forward transition within the scan horizon (e.g. Asia/Singapore has no DST).
 * Fall-back transitions (clocks repeat, no skipped interval) are intentionally ignored.
 */
export function getNextSpringForwardGap(timeZone: string, from: Date): SpringForwardGap | null {
  let prevOffset = tzOffsetMinutes(timeZone, from);
  let prevInstant = from;
  for (let dayIndex = 1; dayIndex <= SCAN_DAYS; dayIndex++) {
    const currInstant = new Date(from.getTime() + dayIndex * MS_PER_DAY);
    const currOffset = tzOffsetMinutes(timeZone, currInstant);
    if (currOffset > prevOffset) {
      return pinpointGap(timeZone, prevInstant, currInstant);
    }
    prevInstant = currInstant;
    prevOffset = currOffset;
  }
  return null;
}

/**
 * True when a weekly wall-clock range would land in the timezone's upcoming spring-forward
 * gap. Only the transition's own weekday is considered (v1: single upcoming transition).
 *
 * Single-day only: `range` must describe one calendar day's own interval
 * (`startMinutes < endMinutes`). A range that crosses midnight (`endMinutes <=
 * startMinutes`, e.g. 22:00→02:00) spans TWO calendar days and is out of scope for this
 * helper — passing one throws rather than silently answering "no gap" (the overlap test
 * below is false for any real gap when `startMinutes > endMinutes`, which would fail
 * open). Callers with a crossing range need the two-interval, week-level check — see
 * `findWeekGapMatch` in apps/web's schedule-helpers.ts — which this does NOT duplicate.
 */
export function isWallClockInSpringForwardGap(
  timeZone: string,
  from: Date,
  range: { dayOfWeek: number; startMinutes: number; endMinutes: number }
): boolean {
  if (range.endMinutes <= range.startMinutes) {
    throw new Error(
      'isWallClockInSpringForwardGap does not support a crossing-midnight range ' +
        '(endMinutes <= startMinutes); use the week-level two-interval check ' +
        '(findWeekGapMatch) for those instead.'
    );
  }
  const gap = getNextSpringForwardGap(timeZone, from);
  // Split guards (not `!gap || …gap.x`) so `gap` narrows to non-null for the reads below.
  if (!gap) return false;
  if (range.dayOfWeek !== gap.dayOfWeek) return false;
  // Interval overlap between [start, end) and [gapStart, gapEnd).
  return range.startMinutes < gap.gapEndMinutes && range.endMinutes > gap.gapStartMinutes;
}
