'use client';

import { useCallback, useRef, useState } from 'react';
import { Camera, Upload, X, Loader2 } from 'lucide-react';
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
        const presignResult = await requestAvatarUploadAction({
          contentType: 'image/webp',
        });
        if (!presignResult.success || !presignResult.presignedUrl || !presignResult.key) {
          throw new Error(presignResult.error ?? 'Failed to prepare upload');
        }

        // Step 3: Upload directly to R2
        failedStep = 'upload';
        const uploadResponse = await fetch(presignResult.presignedUrl, {
          method: 'PUT',
          body: compressed,
          headers: { 'Content-Type': 'image/webp' },
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
    <div className="flex items-start gap-6">
      {/* Avatar */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          disabled={isUploading}
          className={cn(
            'group relative flex h-[88px] w-[88px] cursor-pointer items-center justify-center overflow-hidden rounded-full transition-all duration-200',
            isDragging
              ? 'ring-primary ring-dashed ring-2 ring-offset-2'
              : 'hover:ring-primary/30 hover:ring-4',
            !currentAvatarUrl && 'from-primary bg-gradient-to-br to-violet-600'
          )}
          aria-label="Change profile photo"
        >
          {displayUrl ? (
            <img src={displayUrl} alt="Profile" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl font-semibold text-white">{initials}</span>
          )}

          {/* Hover overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            {isUploading ? (
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            ) : (
              <>
                <Camera className="h-[18px] w-[18px] text-white" />
                <span className="text-[10px] font-semibold text-white">Change</span>
              </>
            )}
          </div>
        </button>

        {/* Online indicator */}
        <div className="border-background bg-success absolute right-0.5 bottom-0.5 h-4 w-4 rounded-full border-2" />
      </div>

      {/* Upload instructions */}
      <div className="flex-1">
        <p className="text-foreground text-sm font-semibold">Profile Photo</p>
        <p className="text-muted-foreground mt-1 mb-3 text-xs leading-relaxed">
          A professional headshot helps clients feel confident booking you. Any image format, up to
          20 MB.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
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
              className="text-muted-foreground"
            >
              {isRemoving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="mr-1.5 h-3.5 w-3.5" />
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
      />
    </div>
  );
}
