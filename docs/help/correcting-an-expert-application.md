# Correcting an expert's application

Sometimes a rating, a product or a certification needs fixing after the fact — a slip during
the interview, a cert that was missed, a product that doesn't belong. **Edit application** on
`/admin/applications/[profileId]` lets you fix it in place, without re-running Approve or
Decline.

## When you can edit

- **Pending** — while the application is `Submitted` or `Under review`, before you've
  decided it.
- **Approved** — after you've approved it, including an application that shows **"Approved,
  no decision record"**. That badge means it was approved before Balo logged decisions, or
  came in from a Bubble import — it's still a live, approved application, and it's still
  editable.

**Declined** applications stay read-only. There's no edit affordance for one — if a decision
needs revisiting, that's a new application, not a correction.

## How it works

Select **Edit application**. The page switches to one page-wide edit mode — there's no
per-section editing. **Approve** and **Decline** disappear while you're editing; they come
back the moment you save or cancel. Make your changes, then **Save changes** commits
everything in one go, or **Cancel** discards them (if you've made changes, Balo asks you to
confirm before throwing them away).

## Reading "Self 8 → 5"

A rating row shows the expert's own self-rating alongside Balo's. In read mode:

- **"Self 8 → 5"** means the expert rated themselves 8, and Balo set it to 5. It only shows
  when the two differ — matching ratings show just Balo's.
- **"Added by Balo"** marks a product staff added that the expert never rated themselves.
  There's no self-rating to show for it.

## Removing a product

Removing a product doesn't erase the expert's self-rating — it stays in the audit record
for that product, alongside whatever Balo had set, so the history of what the expert claimed
is never lost even after the product is gone.

## What approval locks

Once you approve an application, certifications, ratings and products are locked for the
**expert** — they can no longer change these themselves in Settings. Staff edits aren't
affected by this lock; you can still correct any of these sections on an approved
application.

Saving a change on a **live (approved)** application emails the expert to let them know
something changed. Saving on a pending application does not — there's nothing to tell them
yet.

## Reaching an approved expert

From **Lookup**, search for the expert and open their result — the drill-in links straight
to their application, including ones in the "Approved, no decision record" state described
above.
