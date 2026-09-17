# Who can do what in Balo admin

Staff access controls who can open the Balo admin area, and what they can do once they're
in. It's managed from **/admin/staff-access** by anyone who holds "Change what other staff
can do".

## The three roles

- **No staff access** — an ordinary Balo account. Can't open the admin area at all.
- **Admin** — support and operations. Works the queues, runs requests, and manages money
  settings.
- **Super admin** — everything an admin can do, plus impersonation, job re-drives, and
  Staff access itself.

## What admins can do

By default, Admin's bundle covers:

- **Project requests** — close any request, assign a Balo owner, read every file, manage
  staff notes, find and invite experts.
- **Delivery and calls** — approve kickoff and start delivery, cancel a live engagement,
  manage action items, cancel a booked call.
- **Money** — set the Balo fee on a project, create and manage promo codes.
- **Queues** — close alert-queue items, approve or decline expert applications.
- **Platform** — open the Balo admin area.

## Only super admins

A few things stay super-admin-only, on top of everything above:

- Deleting someone else's staff note.
- Using the product as another person (impersonation).
- Re-running a stuck recording or transcript job.
- Changing what other staff can do — this page.

## Custom lists replace, not add

Switching someone to a **Custom** list starts from their role's defaults, so "Admin minus
promo codes" is one click: switch to Custom, then untick "Create and manage promo codes."
A custom list **replaces** the role's bundle — it's never added on top of it.

Changing someone's role resets their list back to the new role's defaults. If they had a
custom list, switch to Custom again afterwards to re-customise it.

## What a custom list does not change

Removing an item from someone's list blocks that specific action. It does **not** hide the
admin pages or menu entries themselves — a few of those stay visible to every staff member
regardless of what's on their list.

## Guard rails

- You can't change your own access — ask another super admin.
- Someone must always be able to open this page and manage staff. Balo won't let a save
  leave nobody holding that.
- Changes are recorded against your name, and take effect the next time the other person
  loads a page.

## Questions?

Reach us any time at [support@getbalo.com](mailto:support@getbalo.com).
