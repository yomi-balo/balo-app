'use client';

import { useCallback, useRef, useState } from 'react';
import { Camera, Upload, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { uploadAvatarAction } from '../_actions/upload-avatar';
import { removeAvatarAction } from '../_actions/remove-avatar';

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
  const [isRemoving, setIsRemoving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      if (isUploading) return;

      // Client-side validation
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
      if (!allowedTypes.has(file.type)) {
        toast.error('Please upload a JPG, PNG, or WebP image.');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast.error('Image must be smaller than 5MB.');
        return;
      }

      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append('file', file);
        const result = await uploadAvatarAction(formData);
        if (result.success && result.avatarUrl) {
          onUploadComplete(result.avatarUrl);
          toast.success('Profile photo updated');
        } else {
          toast.error(result.error ?? 'Failed to upload photo');
        }
      } catch {
        toast.error('Failed to upload photo. Please try again.');
      } finally {
        setIsUploading(false);
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
          {currentAvatarUrl ? (
            <img src={currentAvatarUrl} alt="Profile" className="h-full w-full object-cover" />
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
          A professional headshot helps clients feel confident booking you. JPG or PNG, at least
          400x400px.
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
            {isUploading ? 'Uploading...' : 'Upload photo'}
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
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
