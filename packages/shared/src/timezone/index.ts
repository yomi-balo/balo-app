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
