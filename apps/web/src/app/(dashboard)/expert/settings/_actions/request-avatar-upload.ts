'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { createPresignedAvatarUpload } from '@/lib/storage/avatar';
import { log } from '@/lib/logging';

export interface RequestAvatarUploadInput {
  contentType: string;
}

export interface RequestAvatarUploadResult {
  success: boolean;
  presignedUrl?: string;
  key?: string;
  error?: string;
}

export const requestAvatarUploadAction = withAuth(
  async (session, input: RequestAvatarUploadInput): Promise<RequestAvatarUploadResult> => {
    try {
      const { presignedUrl, key } = await createPresignedAvatarUpload(
        session.user.id,
        input.contentType
      );
      return { success: true, presignedUrl, key };
    } catch (error) {
      log.error('Failed to create presigned avatar upload URL', {
        userId: session.user.id,
        contentType: input.contentType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to prepare upload. Please try again.' };
    }
  }
);
