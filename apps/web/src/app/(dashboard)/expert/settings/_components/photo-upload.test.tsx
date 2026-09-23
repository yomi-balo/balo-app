import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, AVATAR_EVENTS } from '@/lib/analytics';

// The actions `import 'server-only'` — must be mocked or the import throws.
const actions = vi.hoisted(() => ({
  requestAvatarUploadAction: vi.fn(),
  confirmAvatarUploadAction: vi.fn(),
  removeAvatarAction: vi.fn(),
}));
vi.mock('../_actions/request-avatar-upload', () => ({
  requestAvatarUploadAction: actions.requestAvatarUploadAction,
}));
vi.mock('../_actions/confirm-avatar-upload', () => ({
  confirmAvatarUploadAction: actions.confirmAvatarUploadAction,
}));
vi.mock('../_actions/remove-avatar', () => ({
  removeAvatarAction: actions.removeAvatarAction,
}));

const { imageCompression } = vi.hoisted(() => ({ imageCompression: vi.fn() }));
vi.mock('browser-image-compression', () => ({ default: imageCompression }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PhotoUpload } from './photo-upload';

const AVATAR_KEY =
  'avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.webp';

function renderUpload(overrides: Partial<React.ComponentProps<typeof PhotoUpload>> = {}): {
  onUploadComplete: ReturnType<typeof vi.fn>;
  onRemoveComplete: ReturnType<typeof vi.fn>;
} {
  const onUploadComplete = vi.fn();
  const onRemoveComplete = vi.fn();
  render(
    <PhotoUpload
      currentAvatarUrl={null}
      initials="JD"
      onUploadComplete={onUploadComplete}
      onRemoveComplete={onRemoveComplete}
      {...overrides}
    />
  );
  return { onUploadComplete, onRemoveComplete };
}

function fileInput(): HTMLInputElement {
  const input = screen.getByTestId('photo-file-input');
  if (!(input instanceof HTMLInputElement)) throw new Error('file input missing');
  return input;
}

function imageFile(): File {
  return new File([new Uint8Array(2048)], 'me.png', { type: 'image/png' });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  imageCompression.mockResolvedValue(
    new File([new Uint8Array(1024)], 'me.webp', { type: 'image/webp' })
  );
  actions.requestAvatarUploadAction.mockResolvedValue({
    success: true,
    presignedUrl: 'https://r2.example/put',
    key: AVATAR_KEY,
  });
  actions.confirmAvatarUploadAction.mockResolvedValue({ success: true, avatarUrl: AVATAR_KEY });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('PhotoUpload — layout', () => {
  it('shows the initials avatar, title, 5 MB guidance and an upload button', () => {
    renderUpload();

    const avatar = screen.getByRole('button', { name: 'Change profile photo' });
    expect(avatar).toHaveTextContent('JD');
    expect(avatar.className).toContain('size-14');
    expect(screen.getByRole('heading', { name: 'Profile Photo' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'A professional headshot helps clients feel confident booking you. Max 5 MB.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows the photo and a Remove action when one exists', () => {
    renderUpload({ currentAvatarUrl: 'https://cdn.example/me.jpg' });

    expect(screen.getByRole('img', { name: 'Profile' })).toHaveAttribute(
      'src',
      'https://cdn.example/me.jpg'
    );
    const remove = screen.getByRole('button', { name: 'Remove' });
    expect(remove.className).toContain('text-primary');
  });

  it('opens the file picker from the avatar and the upload button', async () => {
    const user = userEvent.setup();
    renderUpload();
    const click = vi.spyOn(fileInput(), 'click');

    await user.click(screen.getByRole('button', { name: 'Upload photo' }));
    await user.click(screen.getByRole('button', { name: 'Change profile photo' }));

    expect(click).toHaveBeenCalledTimes(2);
  });
});

describe('PhotoUpload — upload flow', () => {
  it('compresses, uploads to the presigned URL, confirms, then reports the new key', async () => {
    const { onUploadComplete } = renderUpload();

    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledWith(AVATAR_KEY));
    expect(imageCompression).toHaveBeenCalled();
    expect(actions.requestAvatarUploadAction).toHaveBeenCalledWith({ contentType: 'image/webp' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://r2.example/put',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(actions.confirmAvatarUploadAction).toHaveBeenCalledWith({ key: AVATAR_KEY });
    expect(toast.success).toHaveBeenCalledWith('Profile photo updated');
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_UPLOAD_STARTED, expect.any(Object));
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_UPLOAD_COMPLETED, expect.any(Object));
  });

  it('shows each step on the button and locks it while uploading', async () => {
    let finishConfirm: (v: { success: boolean; avatarUrl: string }) => void = () => {};
    actions.confirmAvatarUploadAction.mockReturnValue(
      new Promise((resolve) => {
        finishConfirm = resolve;
      })
    );
    renderUpload();

    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });

    const saving = await screen.findByRole('button', { name: 'Saving...' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change profile photo' })).toBeDisabled();

    finishConfirm({ success: true, avatarUrl: AVATAR_KEY });
    expect(await screen.findByRole('button', { name: 'Upload photo' })).toBeEnabled();
  });

  it('accepts a photo dropped on the avatar', async () => {
    const { onUploadComplete } = renderUpload();
    const avatar = screen.getByRole('button', { name: 'Change profile photo' });

    expect(avatar.className).not.toContain('ring-offset-2');
    fireEvent.dragOver(avatar);
    expect(avatar.className).toContain('ring-offset-2');
    fireEvent.dragLeave(avatar);
    expect(avatar.className).not.toContain('ring-offset-2');
    fireEvent.drop(avatar, { dataTransfer: { files: [imageFile()] } });

    await waitFor(() => expect(onUploadComplete).toHaveBeenCalledWith(AVATAR_KEY));
  });

  it('refuses a non-image file without starting an upload', () => {
    renderUpload();

    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(toast.error).toHaveBeenCalledWith('Please select an image file.');
    expect(imageCompression).not.toHaveBeenCalled();
  });

  it('reports which step failed when the presign is refused', async () => {
    actions.requestAvatarUploadAction.mockResolvedValue({
      success: false,
      error: 'Failed to prepare upload. Please try again.',
    });
    const { onUploadComplete } = renderUpload();

    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to prepare upload. Please try again.')
    );
    expect(onUploadComplete).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_UPLOAD_FAILED, {
      step: 'presign',
      error: 'Failed to prepare upload. Please try again.',
    });
  });

  it('reports a failed R2 upload', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    renderUpload();

    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Upload failed with status 500'));
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_UPLOAD_FAILED, {
      step: 'upload',
      error: 'Upload failed with status 500',
    });
  });

  it('reports a refused confirm', async () => {
    actions.confirmAvatarUploadAction.mockResolvedValue({
      success: false,
      error: 'Uploaded file is too large. Please try a smaller image.',
    });
    renderUpload();

    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Uploaded file is too large. Please try a smaller image.'
      )
    );
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_UPLOAD_FAILED, {
      step: 'confirm',
      error: 'Uploaded file is too large. Please try a smaller image.',
    });
  });
});

describe('PhotoUpload — remove', () => {
  it('removes the photo, confirms with a toast and tracks it', async () => {
    const user = userEvent.setup();
    actions.removeAvatarAction.mockResolvedValue({ success: true });
    const { onRemoveComplete } = renderUpload({ currentAvatarUrl: 'https://cdn.example/me.jpg' });

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveComplete).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Profile photo removed');
    expect(track).toHaveBeenCalledWith(AVATAR_EVENTS.AVATAR_REMOVED, {});
  });

  it('keeps the photo and explains when removal is refused', async () => {
    const user = userEvent.setup();
    actions.removeAvatarAction.mockResolvedValue({
      success: false,
      error: 'Failed to remove photo. Please try again.',
    });
    const { onRemoveComplete } = renderUpload({ currentAvatarUrl: 'https://cdn.example/me.jpg' });

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveComplete).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Failed to remove photo. Please try again.');
  });

  it('keeps the photo when the removal request throws', async () => {
    const user = userEvent.setup();
    actions.removeAvatarAction.mockRejectedValue(new Error('network'));
    const { onRemoveComplete } = renderUpload({ currentAvatarUrl: 'https://cdn.example/me.jpg' });

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onRemoveComplete).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Failed to remove photo. Please try again.');
  });
});
