'use client';

import { useCallback, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { track, AVATAR_EVENTS } from '@/lib/analytics';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { requestAvatarUploadAction } from '../_actions/request-avatar-upload';
import { confirmAvatarUploadAction } from '../_actions/confirm-avatar-upload';
import { removeAvatarAction } from '../_actions/remove-avatar';

const COMPRESSION_OPTIONS = {
  maxSizeMB: 1,
  maxWidthOrHeight: 1600,
  useWebWorker: true,
  fileType: 'image/webp' as const,
  initialQuality: 0.85,
};

type UploadStep = 'compressing' | 'uploading' | 'saving' | null;

const STEP_LABELS: Record<NonNullable<UploadStep>, string> = {
  compressing: 'Compressing...',
  uploading: 'Uploading...',
  saving: 'Saving...',
};

interface PhotoUploadProps {
  currentAvatarUrl: string | null;
  initials: string;
  onUploadComplete: (avatarUrl: string) => void;
  onRemoveComplete: () => void;
}

export function PhotoUpload({
  currentAvatarUrl,
  initials,
  onUploadComplete,
  onRemoveComplete,
}: Readonly<PhotoUploadProps>): React.JSX.Element {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      if (isUploading) return;

      // Only reject non-image files
      if (!file.type.startsWith('image/')) {
        toast.error('Please select an image file.');
        return;
      }

      setIsUploading(true);
      const startTime = Date.now();
      let failedStep: 'compression' | 'presign' | 'upload' | 'confirm' = 'compression';

      try {
        // Track start
        track(AVATAR_EVENTS.AVATAR_UPLOAD_STARTED, {
          original_size_kb: Math.round(file.size / 1024),
          original_type: file.type,
        });

        // Step 1: Compress
        setUploadStep('compressing');
        failedStep = 'compression';
        const imageCompression = (await import('browser-image-compression')).default;
        const compressed = await imageCompression(file, COMPRESSION_OPTIONS);

        // Step 2: Get presigned URL
        setUploadStep('uploading');
        failedStep = 'presign';
        const compressedType = compressed.type || 'image/webp';
        const presignResult = await requestAvatarUploadAction({
          contentType: compressedType,
        });
        if (!presignResult.success || !presignResult.presignedUrl || !presignResult.key) {
          throw new Error(presignResult.error ?? 'Failed to prepare upload');
        }

        // Step 3: Upload directly to R2
        failedStep = 'upload';
        const uploadResponse = await fetch(presignResult.presignedUrl, {
          method: 'PUT',
          body: compressed,
          headers: { 'Content-Type': compressedType },
        });
        if (!uploadResponse.ok) {
          throw new Error(`Upload failed with status ${uploadResponse.status}`);
        }

        // Step 4: Confirm on server
        setUploadStep('saving');
        failedStep = 'confirm';
        const confirmResult = await confirmAvatarUploadAction({ key: presignResult.key });
        if (!confirmResult.success) {
          throw new Error(confirmResult.error ?? 'Failed to save photo');
        }

        // Success
        onUploadComplete(confirmResult.avatarUrl!);
        toast.success('Profile photo updated');
        track(AVATAR_EVENTS.AVATAR_UPLOAD_COMPLETED, {
          compressed_size_kb: Math.round(compressed.size / 1024),
          compression_ratio: +(file.size / compressed.size).toFixed(1),
          duration_ms: Date.now() - startTime,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to upload photo';
        toast.error(errorMessage);
        track(AVATAR_EVENTS.AVATAR_UPLOAD_FAILED, {
          step: failedStep,
          error: errorMessage,
        });
      } finally {
        setIsUploading(false);
        setUploadStep(null);
      }
    },
    [isUploading, onUploadComplete]
  );

  const handleRemove = useCallback(async () => {
    if (isRemoving) return;
    setIsRemoving(true);
    try {
      const result = await removeAvatarAction();
      if (result.success) {
        onRemoveComplete();
        toast.success('Profile photo removed');
        track(AVATAR_EVENTS.AVATAR_REMOVED, {});
      } else {
        toast.error(result.error ?? 'Failed to remove photo');
      }
    } catch {
      toast.error('Failed to remove photo. Please try again.');
    } finally {
      setIsRemoving(false);
    }
  }, [isRemoving, onRemoveComplete]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleUpload(file);
      }
      // Reset input so re-selecting same file works
      e.target.value = '';
    },
    [handleUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        handleUpload(file);
      }
    },
    [handleUpload]
  );

  const displayUrl = getAvatarUrl(currentAvatarUrl, 'profile');

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={isUploading}
        className={cn(
          'group bg-muted focus-visible:ring-ring/50 relative flex size-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full transition-shadow duration-200 outline-none focus-visible:ring-[3px]',
          isDragging
            ? 'ring-primary ring-offset-card ring-2 ring-offset-2'
            : 'hover:ring-primary/30 hover:ring-4'
        )}
        aria-label="Change profile photo"
      >
        {displayUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- avatar from Cloudflare Image Resizing
          <img src={displayUrl} alt="Profile" className="h-full w-full object-cover" />
        ) : (
          <span className="text-muted-foreground text-base font-semibold">{initials}</span>
        )}

        {/* Hover overlay */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 flex items-center justify-center bg-black/50 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
            isUploading ? 'opacity-100' : 'opacity-0'
          )}
        >
          {isUploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-white motion-reduce:animate-none" />
          ) : (
            <Camera className="h-4 w-4 text-white" />
          )}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <h3 className="text-foreground text-sm font-semibold">Profile Photo</h3>
        <p className="text-muted-foreground mt-0.5 mb-2.5 text-[12.5px] leading-relaxed">
          A professional headshot helps clients feel confident booking you. Max 5 MB.
        </p>
        <div className="flex flex-wrap items-center gap-3.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="text-[13px]"
          >
            {isUploading && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {uploadStep ? STEP_LABELS[uploadStep] : 'Upload photo'}
          </Button>
          {currentAvatarUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={isRemoving}
              className="text-primary hover:text-primary px-1 text-[13px] hover:bg-transparent hover:underline"
            >
              {isRemoving && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              Remove
            </Button>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="photo-file-input"
      />
    </div>
  );
}
