import { test, expect, type Page } from './fixtures/auth';

/**
 * BAL-400 — case-booking E2E suite (plan step 27). Covers:
 *   (a) happy path — book a new case
 *   (b) attach to an existing case
 *   (c) the multi-company picker (the 1-company/2-company halves)
 *   (d) the idempotent same-key replay (the DB precondition a dropped-201 leaves behind)
 *
 * Needs the seeded-E2E harness (ephemeral Postgres + `WORKOS_COOKIE_PASSWORD` +
 * `E2E_TEST_SECRET`) — see `fixtures/auth.ts`. Skips (does not fail) locally when
 * `E2E_TEST_SECRET` is unset, exactly like `onboarding-gate.spec.ts`.
 *
 * ⚠ NOT COVERED HERE, AND WHY (do not "complete" these without re-reading the reasoning):
 *
 * - (c)'s "0 eligible companies → onboarding" arm. Producing it needs a session user with
 *   ZERO live company memberships; the seeding harness has no primitive for removing a user's
 *   OWN personal-workspace membership (`/api/e2e/seed` only ever ADDS a second company), and
 *   building one for a single assertion already covered at the unit layer
 *   (`load-booking-context.test.ts`'s "returns onboarding_required when the actor has zero
 *   eligible companies") and the component layer (`booking-flow-dialog.test.tsx`,
 *   `booking-flow-dialog.a11y.test.tsx`, both driving `arm: 'onboarding_required'` directly)
 *   was judged disproportionate — it would add a new way to strand a real user's ONLY company
 *   for one already-pinned assertion.
 *
 * - (d)'s "different slot after a partial failure → nonce re-mints, no duplicate case" half.
 *   That requires a REAL `POST /meetings` failure mid-session, so the dialog's `recovered`
 *   state gets set. That hop is a server-to-server call the Next.js Server Action makes to
 *   `apps/api` — the browser never issues or sees that request, so Playwright's `page.route()`
 *   cannot intercept or drop it, and no fault-injection lever exists for it anywhere in this
 *   codebase (checked: no `X-Test-*` header, no `FORCE_FAIL`, nothing analogous to
 *   `E2E_TEST_SECRET` for this hop). What IS driven for real below is the DB precondition a
 *   dropped-201 leaves behind — a case row that already carries the SAME
 *   `bookingIdempotencyKey` the browser is about to (re)submit — which exercises the real
 *   `resolveExistingCaseByKey` / `handleCaseCreateError` 23505-catch path, not a stub. The
 *   nonce-re-mint half is covered by `booking-flow-dialog.test.tsx`'s "the nonce is stable
 *   across 'Try again' and regenerates on a slot change".
 */
test.describe('case booking', () => {
  test.skip(!process.env.E2E_TEST_SECRET, 'requires the seeded-E2E harness env (E2E_TEST_SECRET)');

  // ── helpers ───────────────────────────────────────────────────

  function ordinal(n: number): string {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
  }

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  /**
   * Matches react-day-picker's default day-button aria-label — date-fns's "PPPP" format
   * (see react-day-picker's own `labelDayButton` helper), e.g. "Wednesday, August 26th, 2026".
   * Built locally rather than imported from date-fns (not a declared dependency at the repo
   * root) — the weekday/month tables plus an ordinal suffix are the whole of what "PPPP"
   * computes for a plain calendar day.
   */
  function formatDayAriaLabel(date: Date): string {
    const weekday = WEEKDAYS[date.getDay()];
    const month = MONTHS[date.getMonth()];
    return `${weekday}, ${month} ${ordinal(date.getDate())}, ${date.getFullYear()}`;
  }

  /**
   * Selects a bookable day `daysFromNow` days out (2 by default across this suite — far enough
   * to clear "today already partially elapsed" without risking the served availability
   * window's far edge), advancing the calendar's month navigation first if the target falls in
   * a later month. The seeded expert's availability is wide-open every day, so any day in this
   * window is selectable.
   */
  async function selectBookableDay(page: Page, daysFromNow = 2): Promise<Date> {
    const today = new Date();
    const target = new Date(today);
    target.setDate(target.getDate() + daysFromNow);

    const monthsToAdvance =
      (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());
    for (let i = 0; i < monthsToAdvance; i++) {
      await page.getByRole('button', { name: 'Go to the Next Month' }).click();
    }
    await page.getByRole('button', { name: formatDayAriaLabel(target), exact: true }).click();
    return target;
  }

  /**
   * Picks the first offered slot + duration and lands on the booking dialog's `confirm` phase
   * (proven by the "Confirm & book" button becoming visible).
   */
  async function pickSlotAndReachConfirm(page: Page): Promise<void> {
    await selectBookableDay(page);
    await page
      .getByRole('button', { name: /\d{1,2}:\d{2}\s?(AM|PM)/ })
      .first()
      .click();
    await page.getByRole('button', { name: /^Continue with/ }).click();
    await page
      .getByRole('radio', { name: /minutes,/ })
      .first()
      .check();
    await page.getByRole('button', { name: /^Confirm \d+-min consultation$/ }).click();
    await expect(page.getByRole('button', { name: 'Confirm & book' })).toBeVisible();
  }

  async function fillNewCaseDetails(page: Page, title: string): Promise<void> {
    await page.locator('#booking-title').fill(title);
    const description = page.getByRole('textbox', { name: "What you'd like to discuss" });
    await description.click();
    await description.pressSequentially('A real problem statement for this consultation.');
  }

  // ── (a) happy path — book a new case ─────────────────────────────

  test('books a new case: case + meeting created, booked state names the case, no client-calendar promise, no rate anywhere', async ({
    page,
    seedSession,
    seedExpert,
  }) => {
    await seedSession({ onboardingCompleted: true });
    const { username } = await seedExpert();

    await page.goto(`/experts/${username}?book=1&src=profile`);
    await pickSlotAndReachConfirm(page);

    // D4c — the billing line states the minimum only, never a rate.
    await expect(page.getByText('Charged only for time used')).toBeVisible();
    await expect(page.getByText('/min')).toHaveCount(0);

    // Exactly one eligible company (the seeded personal workspace) — picker absent (D1a).
    await expect(page.locator('#booking-company-picker')).toHaveCount(0);

    const caseTitle = `E2E new case ${Date.now()}`;
    await fillNewCaseDetails(page, caseTitle);
    await page.getByRole('button', { name: 'Confirm & book' }).click();

    await expect(page.getByRole('heading', { name: "You're booked!" })).toBeVisible();
    await expect(page.getByText('This started a new case')).toBeVisible();
    await expect(page.getByText(caseTitle)).toBeVisible();
    // D2a — the copy never claims the CLIENT's calendar was updated (only the expert's is,
    // server-side). "Add to calendar" is the permitted client-side .ics download affordance.
    await expect(page.getByText(/your calendar (was|has been) updated/i)).toHaveCount(0);
    await expect(page.getByText(/added to your calendar/i)).toHaveCount(0);
    await expect(page.getByText('/min')).toHaveCount(0);

    await page.getByRole('button', { name: 'View case' }).click();
    await expect(page).toHaveURL(/\/cases\//);
    await expect(page.getByText(caseTitle)).toBeVisible();
  });

  // ── (b) attach to an existing case ───────────────────────────────

  test('attaches to an existing case: no title/description fields, existing case title shown read-only, company not re-asked', async ({
    page,
    seedSession,
    seedExpert,
    seedOpenCase,
  }) => {
    await seedSession({ onboardingCompleted: true });
    const { username, expertProfileId } = await seedExpert();
    const existingTitle = `E2E existing case ${Date.now()}`;
    const { engagementId } = await seedOpenCase({ expertProfileId, title: existingTitle });

    await page.goto(`/experts/${username}?book=1&src=profile`);
    await pickSlotAndReachConfirm(page);

    // An open case exists for this expert — the case-choice section renders; pick it.
    await expect(page.getByRole('radiogroup', { name: 'Which case is this for?' })).toBeVisible();
    await page.getByRole('radio', { name: new RegExp(existingTitle) }).click();

    // Attach shape: no title/description inputs, the existing title shown read-only.
    await expect(page.locator('#booking-title')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: "What you'd like to discuss" })).toHaveCount(0);
    await expect(page.getByText(existingTitle)).toBeVisible();

    // Company is never re-asked on attach (`isNewCase` gates the picker regardless of count).
    await expect(page.locator('#booking-company-picker')).toHaveCount(0);

    await page.getByRole('button', { name: 'Confirm & book' }).click();

    await expect(page.getByRole('heading', { name: "You're booked!" })).toBeVisible();
    await expect(page.getByText('Added to your case')).toBeVisible();
    await expect(page.getByText(existingTitle)).toBeVisible();

    await page.getByRole('button', { name: 'View case' }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${engagementId}`));
  });

  // ── (c) the multi-company picker ─────────────────────────────────

  test('company picker: absent at 1 eligible company, shown (with no default) at 2', async ({
    page,
    seedSession,
    seedExpert,
    seedSecondCompany,
  }) => {
    await seedSession({ onboardingCompleted: true });
    const { username } = await seedExpert();

    // Baseline: exactly 1 eligible company (the seeded personal workspace) — picker absent.
    await page.goto(`/experts/${username}?book=1&src=profile`);
    await pickSlotAndReachConfirm(page);
    await expect(page.locator('#booking-company-picker')).toHaveCount(0);

    // Add a second company, then open a FRESH booking flow.
    const { companyName } = await seedSecondCompany();
    await page.goto(`/experts/${username}?book=1&src=profile`);
    await pickSlotAndReachConfirm(page);

    const picker = page.locator('#booking-company-picker');
    await expect(picker).toBeVisible();

    // D1a — NO DEFAULT SELECTION: with everything else valid, Confirm stays disabled until a
    // company is explicitly chosen.
    const caseTitle = `E2E multi-company ${Date.now()}`;
    await fillNewCaseDetails(page, caseTitle);
    await expect(page.getByRole('button', { name: 'Confirm & book' })).toBeDisabled();

    await picker.click();
    await page.getByRole('option', { name: companyName }).click();
    await expect(page.getByRole('button', { name: 'Confirm & book' })).toBeEnabled();

    await page.getByRole('button', { name: 'Confirm & book' }).click();
    await expect(page.getByRole('heading', { name: "You're booked!" })).toBeVisible();
    await expect(page.getByText(caseTitle)).toBeVisible();
  });

  // ── (d) idempotent replay (the reachable half — see the suite docblock) ──────────

  test('idempotent replay: resubmitting the SAME booking nonce re-enters the already-created case, never a duplicate', async ({
    page,
    seedSession,
    seedExpert,
    seedOpenCase,
    forceBookingNonce,
  }) => {
    await seedSession({ onboardingCompleted: true });
    const { username, expertProfileId } = await seedExpert();

    const nonce = '99999999-9999-4999-8999-999999999999';
    const seededTitle = `E2E replay case ${Date.now()}`;
    // Simulates the DB precondition a dropped-201 on hop 2 leaves behind: a case already
    // exists, stamped with the SAME idempotency key the browser is about to (re)submit, and
    // no meeting yet.
    const { engagementId: seededEngagementId } = await seedOpenCase({
      expertProfileId,
      title: seededTitle,
      bookingNonce: nonce,
    });
    await forceBookingNonce(nonce);

    await page.goto(`/experts/${username}?book=1&src=profile`);
    await pickSlotAndReachConfirm(page);

    // The case-choice default is "Start a new case" — proceed as a fresh submit. The nonce is
    // forced, so the SAME key this mints is what makes the server-side create collide (23505)
    // with the seeded row and recover onto it instead of creating a second case.
    await fillNewCaseDetails(page, `A title the server will never keep ${Date.now()}`);
    await page.getByRole('button', { name: 'Confirm & book' }).click();

    await expect(page.getByRole('heading', { name: "You're booked!" })).toBeVisible();
    // The booked case carries the SEEDED title, not the freshly typed one — proof the
    // 23505-catch → `resolveExistingCaseByKey` path re-entered the existing case rather than
    // creating a duplicate.
    await expect(page.getByText(seededTitle)).toBeVisible();

    await page.getByRole('button', { name: 'View case' }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${seededEngagementId}`));
  });
});
