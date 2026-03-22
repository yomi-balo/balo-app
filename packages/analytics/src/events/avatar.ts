export const AVATAR_EVENTS = {
  AVATAR_UPLOAD_STARTED: 'avatar_upload_started',
  AVATAR_UPLOAD_COMPLETED: 'avatar_upload_completed',
  AVATAR_UPLOAD_FAILED: 'avatar_upload_failed',
  AVATAR_REMOVED: 'avatar_removed',
} as const;

export interface AvatarEventMap {
  [AVATAR_EVENTS.AVATAR_UPLOAD_STARTED]: {
    original_size_kb: number;
    original_type: string;
  };
  [AVATAR_EVENTS.AVATAR_UPLOAD_COMPLETED]: {
    compressed_size_kb: number;
    compression_ratio: number; // original / compressed
    duration_ms: number;
  };
  [AVATAR_EVENTS.AVATAR_UPLOAD_FAILED]: {
    step: 'compression' | 'presign' | 'upload' | 'confirm';
    error: string;
  };
  [AVATAR_EVENTS.AVATAR_REMOVED]: Record<string, never>;
}
