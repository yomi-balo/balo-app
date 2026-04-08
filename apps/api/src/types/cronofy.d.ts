declare module 'cronofy' {
  interface CronofyConfig {
    client_id?: string;
    client_secret?: string;
    access_token?: string;
    refresh_token?: string;
    data_center?: string;
    dataCenter?: string;
  }

  interface TokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
    sub: string;
    account_id: string;
    linking_profile?: {
      provider_name: string;
      profile_id: string;
      profile_name: string;
    };
  }

  interface RequestAccessTokenOptions {
    client_id: string;
    client_secret: string;
    grant_type: 'authorization_code';
    code: string;
    redirect_uri: string;
  }

  interface RefreshAccessTokenOptions {
    client_id: string;
    client_secret: string;
    grant_type: 'refresh_token';
    refresh_token: string;
  }

  interface RevokeAuthorizationOptions {
    client_id: string;
    client_secret: string;
    token: string;
  }

  interface CronofyCalendar {
    calendar_id: string;
    calendar_name: string;
    calendar_readonly: boolean;
    calendar_deleted: boolean;
    calendar_primary: boolean;
    profile_id: string;
    profile_name: string;
    provider_name: string;
    calendar_integrated_conferencing_available?: boolean;
    calendar_color?: string;
  }

  interface ListCalendarsResponse {
    calendars: CronofyCalendar[];
  }

  interface UserInfoProfile {
    provider_name: string;
    profile_id: string;
    profile_name: string;
    profile_connected: boolean;
    profile_initial_sync_required?: boolean;
    profile_relink_url?: string;
  }

  interface UserInfoResponse {
    sub: string;
    cronofy_type: string;
    profiles?: UserInfoProfile[];
    'cronofy.data'?: {
      authorization: {
        scope: string;
        status: string;
      };
    };
  }

  interface CreateNotificationChannelOptions {
    callback_url: string;
    filters?: {
      only_managed?: boolean;
      calendar_ids?: string[];
    };
  }

  interface NotificationChannel {
    channel_id: string;
    callback_url: string;
    filters: Record<string, unknown>;
  }

  interface CreateNotificationChannelResponse {
    channel: NotificationChannel;
  }

  interface DeleteNotificationChannelOptions {
    channel_id: string;
  }

  interface FreeBusyOptions {
    tzid: string;
    from: string;
    to: string;
    calendar_ids?: string[];
  }

  interface FreeBusySlot {
    calendar_id: string;
    start: string;
    end: string;
    status: 'busy' | 'tentative' | 'free';
    free_busy_status?: string;
  }

  interface FreeBusyResponse {
    pages: { current: number; total: number };
    free_busy: FreeBusySlot[];
  }

  class Cronofy {
    constructor(config: CronofyConfig);
    config: CronofyConfig;

    requestAccessToken(options: RequestAccessTokenOptions): Promise<TokenResponse>;
    refreshAccessToken(options: RefreshAccessTokenOptions): Promise<TokenResponse>;
    revokeAuthorization(options: RevokeAuthorizationOptions): Promise<void>;

    listCalendars(): Promise<ListCalendarsResponse>;
    userInfo(): Promise<UserInfoResponse>;

    createNotificationChannel(
      options: CreateNotificationChannelOptions
    ): Promise<CreateNotificationChannelResponse>;
    deleteNotificationChannel(options: DeleteNotificationChannelOptions): Promise<void>;

    freeBusy(options: FreeBusyOptions): Promise<FreeBusyResponse>;

    hmacValid(options: { hmac: string; body: string; client_secret: string }): boolean;
  }

  export = Cronofy;
}
