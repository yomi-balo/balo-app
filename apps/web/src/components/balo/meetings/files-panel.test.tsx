import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { toast } from 'sonner';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingMemberPanelRegistration } from '@/lib/meetings/meeting-panels';
import { dailyState, resetDailyMock } from '@/test/mocks/daily';
import { FilesPanel } from './files-panel';

/**
 * BAL-436 — the Files panel.
 *
 * ── ⚠⚠ WHAT THIS FILE HOLDS ──────────────────────────────────────────────────────────────
 *
 *   1. **ONE UNIFIED LIST.** Chat-attached and Files-dropped rows both appear, ungrouped and
 *      unfiltered — that IS BAL-423's D0 acceptance criterion.
 *   2. **THE UPLOADER LABEL IS NEVER AN ADDRESS AND NEVER A UUID.**
 *   3. **CLIENT-SIDE VALIDATION HAPPENS BEFORE THE PRESIGN** — a 10 MB round trip to be told
 *      no is a bad experience mid-call.
 *   4. **CONFIRM PREPENDS THE RETURNED ROW** — the freshness the deferred `revalidatePath` was
 *      actually about.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockPutWithProgress = vi.fn();
vi.mock('@/components/balo/document-uploader/upload-file', async (importOriginal) => ({
  // ⚠ SPREADS THE REAL MODULE — `formatBytes` is what the row renders, and stubbing it would
  // make the size assertions assert the stub.
  ...(await importOriginal<typeof import('@/components/balo/document-uploader/upload-file')>()),
  putWithProgress: (...args: unknown[]) => mockPutWithProgress(...args),
}));

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const MEETING_PROPS = { meeting_id: MEETING_ID };
const UPLOADER_ID = '11111111-2222-4333-8444-555555555555';

function stubMatchMedia(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function file(overrides: Partial<MeetingFileView> & { id: string }): MeetingFileView {
  return {
    meetingId: MEETING_ID,
    fileName: 'current-cpq-rules.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1_400_000,
    party: 'client',
    source: 'files_tab',
    uploadedByUserId: UPLOADER_ID,
    createdAtIso: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

interface FilesFakes {
  readonly panels: MeetingMemberPanelRegistration;
  readonly list: ReturnType<typeof vi.fn>;
  readonly requestUpload: ReturnType<typeof vi.fn>;
  readonly confirmUpload: ReturnType<typeof vi.fn>;
  readonly download: ReturnType<typeof vi.fn>;
}

function fakes(options: { files?: MeetingFileView[]; failList?: boolean } = {}): FilesFakes {
  const list = vi
    .fn()
    .mockResolvedValue(
      options.failList === true
        ? { success: false, error: 'Could not load files. Please try again.' }
        : { success: true, files: options.files ?? [] }
    );
  const requestUpload = vi
    .fn()
    .mockResolvedValue({ success: true, presignedUrl: 'https://r2.test/put', key: 'k' });
  const confirmUpload = vi
    .fn()
    .mockResolvedValue({ success: true, file: file({ id: 'new-1', fileName: 'notes.pdf' }) });
  const download = vi.fn().mockResolvedValue({ success: true, url: 'https://r2.test/get' });

  return {
    list,
    requestUpload,
    confirmUpload,
    download,
    panels: {
      audience: 'member',
      joinLinkUrl: 'https://balo.test/join/m/x',
      loadGuests: vi.fn(),
      inviteGuests: vi.fn(),
      decideAdmission: vi.fn(),
      resendLink: vi.fn(),
      files: { list, requestUpload, confirmUpload, download },
    } as unknown as MeetingMemberPanelRegistration,
  };
}

/** ⚠ The frame's ONE §16 live region, as a spy. Reassigned per render. */
let onAnnounce = vi.fn();

function renderPanel(fake: FilesFakes, revision = 0): HTMLElement {
  onAnnounce = vi.fn();
  return render(
    <FilesPanel
      panels={fake.panels}
      onClose={vi.fn()}
      meetingProps={MEETING_PROPS}
      onAnnounce={onAnnounce}
      fileRevision={revision}
    />
  ).container;
}

/** A `File` of a given type and size — jsdom does not give us a real one. */
function makeFile(name: string, type: string, size: number): File {
  const handle = new File(['x'], name, { type });
  Object.defineProperty(handle, 'size', { value: size });
  return handle;
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ THE DOWNLOAD SUITE SPIES ON `HTMLAnchorElement.prototype.click` AND ON `location.assign`.
  // Both are process-wide prototypes/globals, so leaving a spy installed would leak into every
  // later file in the run — which is exactly what overwriting `globalThis.location` and never
  // restoring it used to do here.
  vi.restoreAllMocks();
  resetDailyMock();
  stubMatchMedia();
  mockPutWithProgress.mockResolvedValue(undefined);
});

describe('FilesPanel — the four async states', () => {
  it('LOADING: skeleton rows, and ⚠ THE DROP ZONE IS ALREADY LIVE', () => {
    const fake = fakes();
    fake.list.mockReturnValue(new Promise(() => {}));

    renderPanel(fake);

    expect(screen.getByTestId('panel-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share a file with the call/i })).toBeEnabled();
  });

  it('⚠⚠ EMPTY IS AN INVITATION, never "No files yet"', async () => {
    const container = renderPanel(fakes({ files: [] }));

    expect(
      await screen.findByText(/Drop in anything you want to talk through/)
    ).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/no files/i);
  });

  it('ERROR: an inline card plus Retry, with the drop zone still usable', async () => {
    const user = userEvent.setup();
    const fake = fakes({ failList: true });

    renderPanel(fake);

    expect(await screen.findByTestId('panel-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share a file with the call/i })).toBeEnabled();

    fake.list.mockClear();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(fake.list).toHaveBeenCalled());
  });

  it('SUCCESS: the list, with the count in the header', async () => {
    renderPanel(fakes({ files: [file({ id: 'f1' }), file({ id: 'f2', fileName: 'deck.pptx' })] }));

    expect(await screen.findByText('current-cpq-rules.pdf')).toBeInTheDocument();
    expect(screen.getByText('deck.pptx')).toBeInTheDocument();
  });
});

describe('FilesPanel — ⚠⚠ ONE UNIFIED LIST (D0)', () => {
  it('renders BOTH sources, ungrouped and unfiltered', async () => {
    renderPanel(
      fakes({
        files: [
          file({ id: 'f1', fileName: 'from-the-tab.pdf', source: 'files_tab' }),
          file({ id: 'f2', fileName: 'from-chat.png', source: 'chat', contentType: 'image/png' }),
        ],
      })
    );

    expect(await screen.findByText('from-the-tab.pdf')).toBeInTheDocument();
    expect(screen.getByText('from-chat.png')).toBeInTheDocument();
    // ⚠ NO SOURCE HEADINGS — a paperclip glyph is the only distinction, and only for scanning.
    expect(screen.queryByText(/files tab/i)).not.toBeInTheDocument();
  });

  it('marks a chat-originated row in its subtitle', async () => {
    renderPanel(fakes({ files: [file({ id: 'f1', source: 'chat' })] }));

    expect(await screen.findByText(/shared in chat/)).toBeInTheDocument();
  });
});

describe('FilesPanel — ⚠⚠ the uploader label', () => {
  it('resolves a present participant to their FIRST NAME', async () => {
    dailyState.participantIds = ['local-session'];
    dailyState.participants = {
      'local-session': {
        user_name: 'Priya Nair',
        owner: false,
        user_id: `u${UPLOADER_ID.replaceAll('-', '')}`,
      },
    };

    renderPanel(fakes({ files: [file({ id: 'f1' })] }));

    expect(await screen.findByText(/^Priya · /)).toBeInTheDocument();
  });

  it('⚠ falls back to "A participant" when that person is not in the room', async () => {
    renderPanel(fakes({ files: [file({ id: 'f1' })] }));

    expect(await screen.findByText(/^A participant · /)).toBeInTheDocument();
  });

  it('⚠⚠ NEVER renders the uploader`s UUID', async () => {
    const container = renderPanel(fakes({ files: [file({ id: 'f1' })] }));

    await screen.findByText('current-cpq-rules.pdf');
    expect(container.textContent ?? '').not.toContain(UPLOADER_ID);
  });
});

describe('FilesPanel — upload', () => {
  it('runs presign → PUT → confirm and PREPENDS the returned row', async () => {
    const user = userEvent.setup();
    const fake = fakes({ files: [file({ id: 'old', fileName: 'older.pdf' })] });

    renderPanel(fake);
    await screen.findByText('older.pdf');

    const input = screen.getByLabelText(/choose a file to share/i);
    await user.upload(input, makeFile('notes.pdf', 'application/pdf', 2048));

    await waitFor(() => expect(fake.confirmUpload).toHaveBeenCalled());
    expect(fake.requestUpload).toHaveBeenCalledWith({
      contentType: 'application/pdf',
      fileName: 'notes.pdf',
      sizeBytes: 2048,
    });
    expect(mockPutWithProgress).toHaveBeenCalled();

    const names = screen.getAllByText(/\.pdf$/).map((node) => node.textContent);
    expect(names[0]).toBe('notes.pdf');
    // ⚠ NAMES THE FILE — "Shared with the call." is ambiguous the moment two shares are in
    // flight, and it is the only confirmation of WHICH file landed.
    expect(toast.success).toHaveBeenCalledWith('notes.pdf is shared with the call.');
    // ⚠⚠ AND IT REACHES §16'S ONE POLITE LIVE REGION. Sonner is a VISUAL affordance; without
    // this a screen-reader user shared a file and heard nothing at all.
    expect(onAnnounce).toHaveBeenCalledWith('notes.pdf is shared with the call.');
  });

  /**
   * ⚠⚠ A NEAR-MISS DROP MUST NOT END THE CALL.
   *
   * The drop zone's own handlers `preventDefault`, but they only fire for the dashed box. A
   * file released a few pixels outside it reaches the WINDOW's default handler, and the
   * browser's default for a dropped file is to NAVIGATE TO IT — the tab becomes a PDF viewer,
   * the Daily call object unmounts, and the person is out of a live meeting. Drag-and-drop is
   * precisely the interaction where a near miss is the common case.
   *
   * ⚠ BOTH EVENTS MATTER: `drop` is not even delivered unless `dragover` was cancelled first,
   * so cancelling only one of them is a silent no-op rather than a partial fix.
   */
  it.each(['dragover', 'drop'])(
    '⚠⚠ CANCELS a window-level `%s` while mounted — a stray drop must not navigate',
    async (type) => {
      renderPanel(fakes());
      await screen.findByRole('button', { name: /share a file with the call/i });

      const event = new Event(type, { bubbles: true, cancelable: true });
      globalThis.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    }
  );

  it('⚠ STOPS cancelling once the panel unmounts — it does not legislate for the whole app', async () => {
    const view = render(
      <FilesPanel
        panels={fakes().panels}
        onClose={vi.fn()}
        meetingProps={MEETING_PROPS}
        onAnnounce={vi.fn()}
        fileRevision={0}
      />
    );
    await screen.findByRole('button', { name: /share a file with the call/i });
    view.unmount();

    const event = new Event('drop', { bubbles: true, cancelable: true });
    globalThis.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('⚠ SWALLOWS a stray drop rather than uploading it — an unaimed gesture is not consent', async () => {
    const fake = fakes();
    renderPanel(fake);
    await screen.findByRole('button', { name: /share a file with the call/i });

    fireEvent.drop(globalThis.document.body, {
      dataTransfer: { files: [makeFile('notes.pdf', 'application/pdf', 2048)] },
    });

    expect(fake.requestUpload).not.toHaveBeenCalled();
  });

  it('⚠ REJECTS A WRONG TYPE CLIENT-SIDE — no presign, no round trip', async () => {
    const fake = fakes();

    renderPanel(fake);
    /*
      ⚠ DROPPED, NOT PICKED, AND THAT IS THE REALISTIC VECTOR. The hidden input carries an
      `accept` attribute, and both a real file picker and `userEvent.upload` honour it — so a
      disallowed type can only ever arrive through DRAG AND DROP, which `accept` does not
      govern. Testing the picker here would assert the browser's filter rather than ours.
    */
    fireEvent.drop(screen.getByRole('button', { name: /share a file with the call/i }), {
      dataTransfer: { files: [makeFile('virus.exe', 'application/x-msdownload', 100)] },
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(fake.requestUpload).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_SHARED, {
      ...MEETING_PROPS,
      outcome: 'rejected',
      size_bucket: 'under_100kb',
    });
  });

  it('⚠ REJECTS AN OVERSIZED FILE CLIENT-SIDE, with its own remedy', async () => {
    const user = userEvent.setup();
    const fake = fakes();

    renderPanel(fake);
    await user.upload(
      screen.getByLabelText(/choose a file to share/i),
      makeFile('huge.pdf', 'application/pdf', 11 * 1024 * 1024)
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('or smaller'))
    );
    expect(fake.requestUpload).not.toHaveBeenCalled();
  });

  it('⚠ A DUPLICATE CONFIRM IS **INFORMATIONAL**, not an error — a double-click is expected', async () => {
    const user = userEvent.setup();
    const fake = fakes();
    fake.confirmUpload.mockResolvedValue({
      success: false,
      error: 'This file was already shared.',
    });

    renderPanel(fake);
    await user.upload(
      screen.getByLabelText(/choose a file to share/i),
      makeFile('notes.pdf', 'application/pdf', 2048)
    );

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('This file was already shared.'));
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_SHARED, {
      ...MEETING_PROPS,
      outcome: 'duplicate',
      size_bucket: 'under_100kb',
    });
  });

  it('⚠ a PUT that blows up toasts and records `failed`, without a client-side log', async () => {
    const user = userEvent.setup();
    mockPutWithProgress.mockRejectedValue(new Error('network died'));

    renderPanel(fakes());
    await user.upload(
      screen.getByLabelText(/choose a file to share/i),
      makeFile('notes.pdf', 'application/pdf', 2048)
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("We couldn't share that file. Please try again.")
    );
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_SHARED, {
      ...MEETING_PROPS,
      outcome: 'failed',
      size_bucket: 'under_100kb',
    });
  });
});

/**
 * ⚠⚠ THE DOWNLOAD MUST NOT BE A NAVIGATION, AND THAT IS A DEVIATION FROM THE PLAN.
 *
 * The technical plan prescribed `window.location.assign(url)`. That navigates the CURRENT
 * document, which is survivable only if the response is guaranteed to be an attachment — and
 * it is not: the presign is 300s, so an expired or revoked URL answers with R2's XML error
 * body, which the browser RENDERS in the tab. That unmounts the Daily call object and ends the
 * call for this participant, mid-meeting, because they clicked a file.
 *
 * These tests therefore assert the ABSENCE of a navigation as strongly as the presence of the
 * click: `globalThis.location` is left completely alone (an earlier version overwrote it and
 * never restored it, which leaked into every later file in the run), and a spy on
 * `HTMLAnchorElement.prototype.click` proves the anchor path is the one taken.
 */
describe('FilesPanel — download', () => {
  it('⚠⚠ mints a URL and DOWNLOADS it via an anchor — never a navigation', async () => {
    const user = userEvent.setup();
    const anchorClick = vi
      .spyOn(globalThis.HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    // ⚠ `globalThis.location` IS **NOT** TOUCHED HERE, AND THAT IS THE FIX.
    //
    // The previous version overwrote it with `Object.defineProperty` and never restored it,
    // leaking a fake `location` into every later file in the run. It also cannot be spied on:
    // jsdom defines `assign` as non-configurable, so `vi.spyOn(location, 'assign')` throws
    // "Cannot redefine property". The navigation is therefore asserted by its ABSENCE — the
    // document's own `href` is unchanged — plus the positive anchor evidence below.
    const hrefBefore = globalThis.location.href;
    const fake = fakes({ files: [file({ id: 'f1' })] });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Download current-cpq-rules.pdf' }));

    await waitFor(() => expect(fake.download).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));

    // ⚠⚠ THE ASSERTION THAT KEEPS THE CALL ALIVE.
    expect(globalThis.location.href).toBe(hrefBefore);

    const anchor = anchorClick.mock.instances[0] as HTMLAnchorElement | undefined;
    expect(anchor?.href).toBe('https://r2.test/get');
    // ⚠ `download` present (any value) is what marks the anchor as non-navigating intent, and
    // `rel="noopener"` denies a hostile response an `opener` handle back to the call tab.
    expect(anchor?.hasAttribute('download')).toBe(true);
    expect(anchor?.rel).toBe('noopener');

    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_DOWNLOADED, {
      ...MEETING_PROPS,
      outcome: 'ok',
    });
  });

  it('⚠ leaves NO anchor behind in the document — it is appended and removed synchronously', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fake = fakes({ files: [file({ id: 'f1' })] });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Download current-cpq-rules.pdf' }));

    await waitFor(() => expect(fake.download).toHaveBeenCalled());
    expect(globalThis.document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('toasts a download failure and records the outcome', async () => {
    const user = userEvent.setup();
    const fake = fakes({ files: [file({ id: 'f1' })] });
    fake.download.mockResolvedValue({
      success: false,
      error: 'This file is no longer available.',
    });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Download current-cpq-rules.pdf' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This file is no longer available.')
    );
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.FILE_DOWNLOADED, {
      ...MEETING_PROPS,
      outcome: 'failed',
    });
  });
});

describe('FilesPanel — the truncation note', () => {
  it('⚠ NO SILENT CAPS — says so at the bound', async () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      file({ id: `f${index}`, fileName: `doc-${index}.pdf` })
    );

    renderPanel(fakes({ files: many }));

    expect(await screen.findByText('Showing the 200 most recent files.')).toBeInTheDocument();
  });

  it('is absent below the bound', async () => {
    renderPanel(fakes({ files: [file({ id: 'f1' })] }));

    await screen.findByText('current-cpq-rules.pdf');
    expect(screen.queryByText(/most recent files/)).not.toBeInTheDocument();
  });
});

/**
 * BAL-437 — ⚠⚠ **THE REAL INVALIDATION REPLACED BAL-436's `window.focus` STOPGAP.**
 *
 * That listener was named an "Ably substitute" in its own docblock and promised deletion the
 * day the channel landed. It is gone: a `focus` event must now do NOTHING, and a `fileRevision`
 * bump must reload exactly once. Both halves are asserted, because deleting the listener
 * without wiring the replacement would leave the panel strictly staler than before.
 */
describe('FilesPanel — BAL-437, live file invalidation', () => {
  it('⚠⚠ a `fileRevision` bump triggers EXACTLY ONE reload', async () => {
    const fake = fakes();
    const view = render(
      <FilesPanel
        panels={fake.panels}
        onClose={vi.fn()}
        meetingProps={MEETING_PROPS}
        onAnnounce={vi.fn()}
        fileRevision={0}
      />
    );
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(1));

    view.rerender(
      <FilesPanel
        panels={fake.panels}
        onClose={vi.fn()}
        meetingProps={MEETING_PROPS}
        onAnnounce={vi.fn()}
        fileRevision={1}
      />
    );

    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(2));
    // ⚠ AND NOT A THIRD — one event, one reload.
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it('⚠ an UNCHANGED revision does not re-read on a re-render', async () => {
    const fake = fakes();
    const props = {
      panels: fake.panels,
      onClose: vi.fn(),
      meetingProps: MEETING_PROPS,
      onAnnounce: vi.fn(),
      fileRevision: 3,
    };
    const view = render(<FilesPanel {...props} />);
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(1));

    view.rerender(<FilesPanel {...props} />);

    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ the `window.focus` LISTENER IS GONE — a focus event reloads NOTHING', async () => {
    const fake = fakes();
    renderPanel(fake);
    await waitFor(() => expect(fake.list).toHaveBeenCalledTimes(1));

    globalThis.dispatchEvent(new Event('focus'));

    expect(fake.list).toHaveBeenCalledTimes(1);
  });
});

describe('FilesPanel — accessibility', () => {
  it('has no axe violations with a populated list', async () => {
    const container = renderPanel(
      fakes({ files: [file({ id: 'f1' }), file({ id: 'f2', source: 'chat' })] })
    );

    await screen.findAllByText('current-cpq-rules.pdf');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('⚠ carries NO `aria-busy` anywhere', async () => {
    const container = renderPanel(fakes({ files: [file({ id: 'f1' })] }));

    await screen.findByText('current-cpq-rules.pdf');
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});
