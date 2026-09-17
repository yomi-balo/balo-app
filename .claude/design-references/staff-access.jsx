/**
 * staff-access.jsx — Balo admin · Staff access
 *
 * Design reference for the D5 surface (ADR-1035 Amendment 1).
 * Destination: .claude/design-references/staff-access.jsx
 *
 * WHAT THIS SETTLES
 *   1. The override is a MODE, not a per-row tri-state. Because a stored set REPLACES the
 *      role bundle wholesale (A1.2), a person is either "inherited" or "custom" — there is
 *      no row that is half one and half the other. Switching to Custom pre-fills from the
 *      role bundle, so "an admin, minus promo codes" is one click.
 *   2. Role and capabilities are ONE form with one save. A role change ALWAYS resets to
 *      follow the new role (override → the role's bundle) — there is no inline keep-or-reset
 *      choice. Re-customising the new role is one click away: click Custom again and it
 *      pre-fills from THAT role's bundle (ruling 1).
 *   3. The resolved set is the primary read. Same nineteen rows in both modes; one badge says
 *      where the answer came from.
 *   4. Floor rules are disabled states with copy, never a failed save: someone must still be
 *      able to open this page and manage staff (D2); your own record is read-only and the
 *      server refuses it (D3); Custom is unavailable for No staff access (D9).
 *   5. A security write gets a diff before it commits.
 *
 * COLOURS are placeholders mapped to shadcn token names — swap for the real values in
 * apps/web/src/app/globals.css at implementation. Font is Geist (repo font, not DM Sans).
 */

import { useMemo, useState } from 'react';

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');

.sa-root {
  --background: #F7F8FA;
  --card: #FFFFFF;
  --border: #E4E7EC;
  --border-strong: #D0D5DD;
  --foreground: #101828;
  --muted: #667085;
  --muted-2: #98A2B3;
  --primary: #4F46E5;
  --primary-tint: #EEF0FF;
  --primary-ink: #3730A3;
  --danger: #B42318;
  --danger-tint: #FEF3F2;
  --warn-tint: #FFFAEB;
  --warn-ink: #B54708;
  --warn-border: #FEDF89;
  --ok: #067647;

  font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--foreground);
  background: var(--background);
  min-height: 100vh;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.sa-root *, .sa-root *::before, .sa-root *::after { box-sizing: border-box; }
.sa-root button { font-family: inherit; font-size: inherit; cursor: pointer; }
.sa-root :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }

@media (prefers-reduced-motion: reduce) {
  .sa-root *, .sa-root *::before, .sa-root *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* ---------- prototype controls (NOT part of the design) ---------- */
.proto-bar {
  background: #1D2939; color: #EAECF0; padding: 10px 20px;
  display: flex; gap: 20px; align-items: center; flex-wrap: wrap;
  font-size: 12px;
}
.proto-bar b { font-weight: 600; color: #F9FAFB; margin-right: 8px; }
.proto-seg { display: inline-flex; background: #344054; border-radius: 6px; padding: 2px; }
.proto-seg button {
  border: 0; background: transparent; color: #D0D5DD; padding: 4px 10px;
  border-radius: 4px; font-size: 12px;
}
.proto-seg button[data-on='true'] { background: #F9FAFB; color: #1D2939; font-weight: 600; }

/* ---------- page shell ---------- */
.page { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; }
.crumb { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.015em; margin: 0 0 6px; }
.sub { color: var(--muted); margin: 0 0 28px; max-width: 62ch; }

.split { display: grid; grid-template-columns: 300px 1fr; gap: 24px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: 0 1px 2px rgba(16,24,40,0.04);
}
.card-pad { padding: 20px; }
.card-head {
  padding: 16px 20px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.card-title { font-size: 15px; font-weight: 600; margin: 0; }
.card-note { font-size: 13px; color: var(--muted); margin: 4px 0 0; }

/* ---------- roster ---------- */
.roster-search {
  width: 100%; border: 1px solid var(--border-strong); border-radius: 8px;
  padding: 8px 11px; font-size: 13px; font-family: inherit; color: var(--foreground);
}
.roster-search::placeholder { color: var(--muted-2); }
.roster-list { list-style: none; margin: 0; padding: 6px; }
.roster-item {
  width: 100%; display: flex; gap: 10px; align-items: center; text-align: left;
  border: 0; background: transparent; padding: 9px 10px; border-radius: 8px;
}
.roster-item:hover { background: #F2F4F7; }
.roster-item[data-active='true'] { background: var(--primary-tint); }
.avatar {
  width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
  display: grid; place-items: center; font-size: 11px; font-weight: 600;
  background: #E9EAEB; color: #475467;
}
.roster-item[data-active='true'] .avatar { background: var(--primary); color: #fff; }
.roster-name { font-weight: 500; font-size: 13px; }
.roster-meta { font-size: 12px; color: var(--muted); }

/* ---------- badges ---------- */
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500;
  border: 1px solid transparent; white-space: nowrap;
}
.badge-role { background: #F2F4F7; color: #344054; border-color: var(--border); }
.badge-super { background: var(--primary-tint); color: var(--primary-ink); border-color: #C7CDFF; }
.badge-custom { background: var(--warn-tint); color: var(--warn-ink); border-color: var(--warn-border); }

/* ---------- detail ---------- */
.detail-head { padding: 20px; border-bottom: 1px solid var(--border); }
.detail-top { display: flex; gap: 14px; align-items: center; }
.avatar-lg { width: 44px; height: 44px; font-size: 14px; }
.detail-name { font-size: 17px; font-weight: 600; margin: 0; }
.detail-email { color: var(--muted); font-size: 13px; margin: 2px 0 0; }

.banner {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 11px 14px; border-radius: 9px; font-size: 13px; line-height: 1.45;
  border: 1px solid transparent;
}
.banner-warn { background: var(--warn-tint); border-color: var(--warn-border); color: #93370D; }
.banner-info { background: #F8F9FC; border-color: var(--border); color: #475467; }
.banner b { font-weight: 600; }

.field-label { font-size: 13px; font-weight: 600; margin: 0 0 3px; }
.field-help { font-size: 13px; color: var(--muted); margin: 0 0 10px; max-width: 60ch; }

/* ---------- segmented ---------- */
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 9px; padding: 3px; background: #F9FAFB; }
.seg button {
  border: 0; background: transparent; padding: 6px 14px; border-radius: 6px;
  font-size: 13px; font-weight: 500; color: var(--muted);
}
.seg button[data-on='true'] { background: var(--card); color: var(--foreground); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,0.08); }
.seg button:disabled { opacity: 0.45; cursor: not-allowed; }

/* ---------- role options ---------- */
.roles { display: grid; gap: 8px; }
.role-opt {
  display: flex; gap: 11px; align-items: flex-start; text-align: left;
  border: 1px solid var(--border-strong); background: var(--card);
  border-radius: 10px; padding: 12px 14px; width: 100%;
}
.role-opt[data-on='true'] { border-color: var(--primary); background: var(--primary-tint); }
.role-opt:disabled { opacity: 0.55; cursor: not-allowed; background: #FCFCFD; }
.radio {
  width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--border-strong);
  flex: 0 0 auto; margin-top: 2px; display: grid; place-items: center; background: #fff;
}
.role-opt[data-on='true'] .radio { border-color: var(--primary); }
.radio span { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); }
.role-title { font-weight: 600; font-size: 13px; }
.role-desc { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.role-block { font-size: 12.5px; color: var(--warn-ink); margin-top: 5px; font-weight: 500; }

/* ---------- capability table ---------- */
.group-label {
  font-size: 13px; font-weight: 600; color: var(--foreground);
  padding: 16px 20px 6px; margin: 0;
}
.cap-row {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 9px 20px; border-radius: 0; width: 100%; text-align: left;
  border: 0; background: transparent; border-top: 1px solid #F2F4F7;
}
.cap-row:first-of-type { border-top: 0; }
.cap-row[data-editable='true']:hover { background: #FAFBFC; }
.cap-row:disabled { cursor: default; }
.cap-body { flex: 1; min-width: 0; }
.cap-name { font-size: 13px; font-weight: 500; }
.cap-row[data-held='false'] .cap-name { color: var(--muted); }
.cap-token { font-size: 11.5px; color: var(--muted-2); margin-top: 1px; }
.cap-super { font-size: 11.5px; color: var(--primary-ink); margin-top: 3px; font-weight: 500; }

.tick {
  width: 18px; height: 18px; border-radius: 5px; flex: 0 0 auto; margin-top: 1px;
  display: grid; place-items: center;
  border: 1.5px solid var(--border-strong); background: #fff; color: #fff;
}
.tick[data-on='true'] { background: var(--primary); border-color: var(--primary); }
.tick[data-locked='true'] { background: #D0D5DD; border-color: #D0D5DD; }
.tick[data-readonly='true'][data-on='false'] { border-color: #E4E7EC; background: #F9FAFB; }

.count-line {
  padding: 14px 20px; border-top: 1px solid var(--border);
  font-size: 13px; color: var(--muted); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
}

/* ---------- action bar ---------- */
.actions {
  position: sticky; bottom: 0; margin-top: 20px;
  background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px 18px; display: flex; align-items: center; justify-content: space-between;
  gap: 14px; flex-wrap: wrap; box-shadow: 0 -2px 10px rgba(16,24,40,0.05);
}
.btn {
  border-radius: 8px; padding: 8px 15px; font-size: 13px; font-weight: 500;
  border: 1px solid transparent;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:disabled { background: #C7CDFF; cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--muted); border-color: var(--border-strong); }
.btn-link { background: none; border: 0; color: var(--primary); font-weight: 500; padding: 0; }
.btn-link:disabled { color: var(--muted-2); cursor: not-allowed; }

/* ---------- dialog ---------- */
.scrim {
  position: fixed; inset: 0; background: rgba(16,24,40,0.45);
  display: grid; place-items: center; padding: 24px; z-index: 40;
}
.dialog {
  background: var(--card); border-radius: 14px; width: 100%; max-width: 520px;
  box-shadow: 0 20px 40px rgba(16,24,40,0.2); overflow: hidden;
}
.dialog-body { padding: 20px; display: grid; gap: 14px; }
.dialog-foot { padding: 14px 20px; background: #FCFCFD; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 9px; }
.diff { display: grid; gap: 6px; }
.diff-line { display: flex; gap: 9px; align-items: baseline; font-size: 13px; }
.diff-mark { font-weight: 700; width: 12px; flex: 0 0 auto; font-size: 14px; }
.diff-add .diff-mark { color: var(--ok); }
.diff-rm .diff-mark { color: var(--danger); }
.diff-rm .diff-text { color: #475467; }

/* ---------- states ---------- */
.state { padding: 56px 24px; text-align: center; }
.state h3 { font-size: 15px; font-weight: 600; margin: 12px 0 4px; }
.state p { color: var(--muted); font-size: 13px; margin: 0 auto; max-width: 44ch; }
.state .btn { margin-top: 16px; }
.skel { background: #EAECF0; border-radius: 6px; animation: sa-pulse 1.4s ease-in-out infinite; }
@keyframes sa-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
`;

/* ------------------------------------------------------------------ icons */
const Check = ({ s = 11 }) => (
  <svg
    width={s}
    height={s}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={3.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const Lock = () => (
  <svg
    width={11}
    height={11}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
);
const Shield = ({ s = 15, c = 'currentColor' }) => (
  <svg
    width={s}
    height={s}
    viewBox="0 0 24 24"
    fill="none"
    stroke={c}
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const Alert = ({ c = 'currentColor' }) => (
  <svg
    width={15}
    height={15}
    viewBox="0 0 24 24"
    fill="none"
    stroke={c}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, marginTop: 1 }}
  >
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);
const Users = () => (
  <svg
    width={28}
    height={28}
    viewBox="0 0 24 24"
    fill="none"
    stroke="#98A2B3"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
  </svg>
);

/* ------------------------------------------------------------------ data */
// Nineteen tokens — the full LIVE @balo/shared/authz/platform.ts axis: BAL-558's two
// request-sourcing conversions (manage_any_request_sourcing, manage_any_kickoff_gate) and
// BAL-560's manage_staff_capabilities have all shipped. `super: true` marks the four tokens
// that may sit only on a super_admin row; fast_forward_request is a dev-only note, not a
// super-only token — both staff roles hold it.
const GROUPS = [
  {
    label: 'Project requests',
    caps: [
      { id: 'close_any_request', name: 'Close any project request' },
      { id: 'assign_any_request_owner', name: 'Assign a Balo owner to a request' },
      { id: 'view_any_request_file', name: 'Read every file on any request' },
      { id: 'manage_internal_notes', name: 'Read and write staff notes' },
      { id: 'delete_any_internal_note', name: "Delete someone else's staff note", super: true },
      { id: 'manage_any_request_sourcing', name: 'Find and invite experts on any request' },
    ],
  },
  {
    label: 'Delivery and calls',
    caps: [
      {
        id: 'manage_any_kickoff_gate',
        name: 'Approve kickoff and start delivery on any request',
      },
      { id: 'cancel_any_engagement', name: 'Cancel any live engagement' },
      { id: 'manage_any_engagement_action_item', name: 'Manage action items on any engagement' },
      { id: 'cancel_any_meeting', name: 'Cancel any booked call' },
    ],
  },
  {
    label: 'Money',
    caps: [
      { id: 'manage_platform_fees', name: 'Set the Balo fee on a project' },
      { id: 'manage_promo_codes', name: 'Create and manage promo codes' },
    ],
  },
  {
    label: 'Queues',
    caps: [
      { id: 'resolve_admin_alerts', name: 'Close items in the alert queue' },
      { id: 'review_expert_applications', name: 'Approve or decline expert applications' },
    ],
  },
  {
    label: 'Platform',
    caps: [
      { id: 'view_platform_admin', name: 'Open the Balo admin area' },
      { id: 'redrive_job', name: 'Re-run a stuck recording or transcript job', super: true },
      { id: 'impersonate_user', name: 'Use the product as another person', super: true },
      { id: 'manage_staff_capabilities', name: 'Change what other staff can do', super: true },
      {
        id: 'fast_forward_request',
        name: 'Fast-forward a request for testing',
        note: 'Only works in development. Does nothing in production.',
      },
    ],
  },
];
const ALL_CAPS = GROUPS.flatMap((g) => g.caps);
const CAP_BY_ID = Object.fromEntries(ALL_CAPS.map((c) => [c.id, c]));

const STAFF_BUNDLE = ALL_CAPS.filter((c) => !c.super).map((c) => c.id);
const ROLE_BUNDLES = {
  user: [],
  admin: STAFF_BUNDLE,
  super_admin: ALL_CAPS.map((c) => c.id),
};
const ROLES = [
  {
    id: 'user',
    title: 'No staff access',
    desc: 'An ordinary Balo account. Cannot open the admin area.',
  },
  {
    id: 'admin',
    title: 'Admin',
    desc: 'Support and operations. Works the queues, runs requests, manages money settings.',
  },
  {
    id: 'super_admin',
    title: 'Super admin',
    desc: 'Everything an admin can do, plus impersonation, job re-drives, and this page.',
  },
];

const PEOPLE = [
  {
    id: 'u1',
    first: 'Yomi',
    last: 'Joseph',
    email: 'yomi@getbalo.com',
    role: 'super_admin',
    capabilities: null,
  },
  {
    id: 'u2',
    first: 'Michael',
    last: 'Joo',
    email: 'mj@getbalo.com',
    role: 'super_admin',
    capabilities: null,
  },
  {
    id: 'u3',
    first: 'Adeeb',
    last: 'Rahman',
    email: 'adeeb@getbalo.com',
    role: 'admin',
    // The case the override exists for: an admin, minus the money settings.
    capabilities: STAFF_BUNDLE.filter(
      (c) => c !== 'manage_promo_codes' && c !== 'manage_platform_fees'
    ),
  },
  {
    id: 'u4',
    first: 'Luke',
    last: 'Brennan',
    email: 'luke@getbalo.com',
    role: 'admin',
    capabilities: null,
  },
];

const initials = (p) => `${p.first[0]}${p.last[0]}`;
const fullName = (p) => `${p.first} ${p.last}`;
const resolved = (role, capabilities) => new Set(capabilities ?? ROLE_BUNDLES[role]);

/* ------------------------------------------------------------------ pieces */
function RoleBadge({ role, custom }) {
  if (role === 'user') return <span className="badge badge-role">No staff access</span>;
  return (
    <>
      <span className={`badge ${role === 'super_admin' ? 'badge-super' : 'badge-role'}`}>
        {role === 'super_admin' ? <Shield s={11} /> : null}
        {role === 'super_admin' ? 'Super admin' : 'Admin'}
      </span>
      {custom ? <span className="badge badge-custom">Custom access</span> : null}
    </>
  );
}

function CapabilityRow({ cap, held, editable, locked, lockReason, onToggle }) {
  const Tag = editable && !locked ? 'button' : 'div';
  return (
    <Tag
      className="cap-row"
      data-editable={editable && !locked}
      data-held={held}
      onClick={editable && !locked ? onToggle : undefined}
      type={editable && !locked ? 'button' : undefined}
      aria-pressed={editable && !locked ? held : undefined}
      title={locked ? lockReason : undefined}
    >
      <span className="tick" data-on={held} data-locked={locked} data-readonly={!editable}>
        {locked ? <Lock /> : held ? <Check /> : null}
      </span>
      <span className="cap-body">
        <span className="cap-name">{cap.name}</span>
        <div className="cap-token">{cap.id}</div>
        {cap.note ? <div className="cap-token">{cap.note}</div> : null}
        {locked ? <div className="cap-super">{lockReason}</div> : null}
      </span>
    </Tag>
  );
}

function ConfirmDialog({ person, before, after, roleBefore, roleAfter, onCancel, onConfirm }) {
  const added = [...after].filter((c) => !before.has(c));
  const removed = [...before].filter((c) => !after.has(c));
  const roleChanged = roleBefore !== roleAfter;
  const label = (r) => ROLES.find((x) => x.id === r).title;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Confirm access change">
      <div className="dialog">
        <div className="card-head">
          <h3 className="card-title">Change {person.first}&rsquo;s access?</h3>
        </div>
        <div className="dialog-body">
          {roleChanged ? (
            <div className="banner banner-info">
              <span>
                Role moves from <b>{label(roleBefore)}</b> to <b>{label(roleAfter)}</b>.
              </span>
            </div>
          ) : null}

          {added.length === 0 && removed.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              What {person.first} can do does not change — only the role label moves.
            </p>
          ) : (
            <div className="diff">
              {added.map((c) => (
                <div key={c} className="diff-line diff-add">
                  <span className="diff-mark">+</span>
                  <span className="diff-text">{CAP_BY_ID[c].name}</span>
                </div>
              ))}
              {removed.map((c) => (
                <div key={c} className="diff-line diff-rm">
                  <span className="diff-mark">&minus;</span>
                  <span className="diff-text">{CAP_BY_ID[c].name}</span>
                </div>
              ))}
            </div>
          )}

          <div className="banner banner-info">
            <span>
              This is recorded against your name and takes effect on {person.first}&rsquo;s next
              page load.
            </span>
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ floor */
// D2 — someone must still hold BOTH manage_staff_capabilities and view_platform_admin, not just
// "a sole super admin". Generalised from the narrower prototype framing this replaces.
function floorHolds(peopleList) {
  return peopleList.some((p) => {
    const set = resolved(p.role, p.capabilities);
    return set.has('manage_staff_capabilities') && set.has('view_platform_admin');
  });
}
function withDraft(peopleList, targetId, role, capabilities) {
  return peopleList.map((p) => (p.id === targetId ? { ...p, role, capabilities } : p));
}

/* ------------------------------------------------------------------ detail */
function Detail({ person, viewerId, people, onSave }) {
  const savedSet = useMemo(() => resolved(person.role, person.capabilities), [person]);

  const [role, setRole] = useState(person.role);
  const [mode, setMode] = useState(person.capabilities ? 'custom' : 'inherited');
  const [custom, setCustom] = useState(() => new Set(savedSet));
  const [confirming, setConfirming] = useState(false);

  const isSelf = person.id === viewerId;
  const readOnly = isSelf;

  const draftSet = useMemo(
    () => (mode === 'inherited' ? new Set(ROLE_BUNDLES[role]) : new Set(custom)),
    [mode, role, custom]
  );

  const dirty =
    role !== person.role ||
    (mode === 'custom') !== Boolean(person.capabilities) ||
    draftSet.size !== savedSet.size ||
    [...draftSet].some((c) => !savedSet.has(c));

  // D9 — Custom is unavailable for role 'user'.
  const switchToCustom = () => {
    if (role === 'user') return;
    setCustom(new Set(ROLE_BUNDLES[role])); // pre-fill from the bundle — subtraction is one click
    setMode('custom');
  };

  const toggle = (id) => {
    setCustom((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // A role pick ALWAYS resets to follow-role (ruling 1), so (r, null) IS the draft this checks.
  const roleBlockedReason = (r) => {
    if (floorHolds(withDraft(people, person.id, r, null))) return null;
    return `${person.first} is the only person who can open this page and manage staff. Give someone else that access first.`;
  };

  const lockFor = (cap) => {
    if (mode !== 'custom') return null;
    if (cap.id === 'manage_staff_capabilities' && role !== 'super_admin') {
      return 'Only a super admin can hold this.';
    }
    if (!custom.has(cap.id)) return null;
    const without = new Set(custom);
    without.delete(cap.id);
    if (floorHolds(withDraft(people, person.id, role, [...without]))) return null;
    return 'Removing this leaves no one able to open this page and manage staff.';
  };

  return (
    <div>
      <div className="card">
        <div className="detail-head">
          <div className="detail-top">
            <div className="avatar avatar-lg">{initials(person)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="detail-name">{fullName(person)}</h2>
              <p className="detail-email">{person.email}</p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <RoleBadge role={person.role} custom={Boolean(person.capabilities)} />
            </div>
          </div>

          {readOnly ? (
            <div className="banner banner-warn" style={{ marginTop: 16 }}>
              <Alert c="#B54708" />
              <span>You cannot change your own access. Ask another super admin.</span>
            </div>
          ) : null}
        </div>

        <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
          <p className="field-label">Role</p>
          <p className="field-help">Sets the starting list of what they can do.</p>
          <div className="roles">
            {ROLES.map((r) => {
              const blockReason = readOnly ? null : roleBlockedReason(r.id);
              const disabled = readOnly || Boolean(blockReason);
              return (
                <button
                  key={r.id}
                  className="role-opt"
                  data-on={role === r.id}
                  disabled={disabled}
                  onClick={() => {
                    // Ruling 1 — every role change resets to follow-role.
                    setRole(r.id);
                    setMode('inherited');
                  }}
                >
                  <span className="radio">{role === r.id ? <span /> : null}</span>
                  <span>
                    <span className="role-title">{r.title}</span>
                    <div className="role-desc">{r.desc}</div>
                    {blockReason ? <div className="role-block">{blockReason}</div> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card-head">
          <div>
            <h3 className="card-title">What they can do</h3>
            <p className="card-note">
              {mode === 'inherited'
                ? 'Following the role. Change the role and this list changes with it.'
                : 'A custom list. It replaces the role defaults rather than adding to them.'}
            </p>
          </div>
          <div className="seg">
            <button
              data-on={mode === 'inherited'}
              disabled={readOnly}
              onClick={() => setMode('inherited')}
            >
              Follow role
            </button>
            <button
              data-on={mode === 'custom'}
              disabled={readOnly || role === 'user'}
              onClick={switchToCustom}
            >
              Custom
            </button>
          </div>
        </div>
        {role === 'user' ? (
          <p className="card-note" style={{ padding: '0 20px 14px' }}>
            A custom list needs the Admin or Super admin role.
          </p>
        ) : null}

        {GROUPS.map((g) => (
          <div key={g.label}>
            <p className="group-label">{g.label}</p>
            {g.caps.map((cap) => {
              const lock = lockFor(cap);
              return (
                <CapabilityRow
                  key={cap.id}
                  cap={cap}
                  held={draftSet.has(cap.id)}
                  editable={mode === 'custom' && !readOnly}
                  locked={Boolean(lock) && mode === 'custom'}
                  lockReason={lock}
                  onToggle={() => toggle(cap.id)}
                />
              );
            })}
          </div>
        ))}

        <div className="count-line">
          <span>
            {draftSet.size} of {ALL_CAPS.length} ·{' '}
            {mode === 'inherited' ? 'from role' : 'set for this person'}
          </span>
          {mode === 'custom' && !readOnly ? (
            <button className="btn-link" onClick={() => setMode('inherited')}>
              Go back to following the role
            </button>
          ) : null}
        </div>
      </div>

      {!readOnly ? (
        <div className="actions">
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {dirty ? 'Unsaved changes' : 'No changes'}
          </span>
          <span style={{ display: 'flex', gap: 9 }}>
            <button
              className="btn btn-ghost"
              disabled={!dirty}
              onClick={() => {
                setRole(person.role);
                setMode(person.capabilities ? 'custom' : 'inherited');
                setCustom(new Set(savedSet));
              }}
            >
              Discard
            </button>
            <button
              className="btn btn-primary"
              disabled={!dirty}
              onClick={() => setConfirming(true)}
            >
              Review and save
            </button>
          </span>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          person={person}
          before={savedSet}
          after={draftSet}
          roleBefore={person.role}
          roleAfter={role}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            onSave({
              ...person,
              role,
              capabilities: mode === 'custom' ? [...draftSet] : null,
            });
            setConfirming(false);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ states */
const Loading = () => (
  <div className="split">
    <div className="card card-pad" style={{ display: 'grid', gap: 12 }}>
      {[...Array(5)].map((_, i) => (
        <div key={i} className="skel" style={{ height: 38 }} />
      ))}
    </div>
    <div className="card card-pad" style={{ display: 'grid', gap: 14 }}>
      <div className="skel" style={{ height: 52, width: '60%' }} />
      {[...Array(8)].map((_, i) => (
        <div key={i} className="skel" style={{ height: 30 }} />
      ))}
    </div>
  </div>
);

const Empty = ({ onGiveAccess }) => (
  <div className="card state">
    <Users />
    <h3>Give someone staff access</h3>
    <p>
      Staff access lets someone open the Balo admin area. Find them by the email they signed up
      with.
    </p>
    <button className="btn btn-primary" onClick={onGiveAccess}>
      Give someone access
    </button>
  </div>
);

const Failed = ({ onRetry }) => (
  <div className="card state">
    <Alert c="#B42318" />
    <h3>Staff access did not load</h3>
    <p>The list could not be read. Nothing has changed — try again.</p>
    <button className="btn btn-ghost" onClick={onRetry}>
      Try again
    </button>
  </div>
);

const NoAccess = () => (
  <div className="card state">
    <Shield s={28} c="#98A2B3" />
    <h3>Only people who manage staff can open this page</h3>
    <p>Ask a super admin if someone&rsquo;s access needs to change.</p>
  </div>
);

/* ------------------------------------------------------------------ add staff */
// Non-staff prototype accounts the email lookup can "find". A person already on `PEOPLE` is
// handled separately (the "already has staff access" outcome), never listed here.
const ACCOUNTS = [
  { id: 'a1', first: 'Priya', last: 'Shah', email: 'priya@northwind.com.au' },
  { id: 'a2', first: 'Marcus', last: 'Webb', email: 'marcus@getbalo.com' },
];

function AddStaffDialog({ people, onClose, onPromote }) {
  const [step, setStep] = useState('lookup'); // 'lookup' | 'promote' | 'confirm'
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [candidate, setCandidate] = useState(null);
  const [role, setRole] = useState('admin');

  const findAccount = () => {
    const needle = email.trim().toLowerCase();
    if (!needle) {
      setError('Enter a full email address.');
      return;
    }
    const alreadyStaff = people.find((p) => p.email.toLowerCase() === needle);
    if (alreadyStaff) {
      setError(`${fullName(alreadyStaff)} already has staff access.`);
      return;
    }
    const found = ACCOUNTS.find((a) => a.email.toLowerCase() === needle);
    if (!found) {
      // ONE generic message — no partial matching, no listing (ruling 3).
      setError('No account found with that email.');
      return;
    }
    setError('');
    setCandidate(found);
    setRole('admin');
    setStep('promote');
  };

  if (step === 'confirm' && candidate) {
    return (
      <ConfirmDialog
        person={candidate}
        before={resolved('user', null)}
        after={resolved(role, null)}
        roleBefore="user"
        roleAfter={role}
        onCancel={() => setStep('promote')}
        onConfirm={() => onPromote(candidate, role)}
      />
    );
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Give someone access">
      <div className="dialog">
        <div className="card-head">
          <h3 className="card-title">
            {step === 'lookup' ? 'Give someone access' : `Give ${candidate?.first} staff access`}
          </h3>
        </div>
        <div className="dialog-body">
          {step === 'lookup' ? (
            <>
              <div>
                <p className="field-label">Email they signed up with</p>
                <input
                  className="roster-search"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </div>
              {error ? (
                <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{error}</p>
              ) : null}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div className="avatar">{initials(candidate)}</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{fullName(candidate)}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{candidate.email}</div>
                </div>
              </div>
              <div className="roles">
                {ROLES.filter((r) => r.id !== 'user').map((r) => (
                  <button
                    key={r.id}
                    className="role-opt"
                    data-on={role === r.id}
                    onClick={() => setRole(r.id)}
                  >
                    <span className="radio">{role === r.id ? <span /> : null}</span>
                    <span>
                      <span className="role-title">{r.title}</span>
                      <div className="role-desc">{r.desc}</div>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {step === 'lookup' ? (
            <button className="btn btn-primary" onClick={findAccount}>
              Find account
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setStep('confirm')}>
              Review and save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */
export default function StaffAccess() {
  const [view, setView] = useState('ready'); // ready | loading | empty | error | denied
  const [viewerId, setViewerId] = useState('u2'); // MJ by default, so u1 shows the self-lock
  const [people, setPeople] = useState(PEOPLE);
  const [selectedId, setSelectedId] = useState('u3'); // Adeeb — the custom-list case
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const shown = people.filter((p) =>
    `${fullName(p)} ${p.email}`.toLowerCase().includes(query.toLowerCase())
  );
  const selected = people.find((p) => p.id === selectedId);

  const handlePromote = (candidate, role) => {
    setPeople((prev) => [...prev, { ...candidate, role, capabilities: null }]);
    setSelectedId(candidate.id);
    setAddOpen(false);
  };

  return (
    <div className="sa-root">
      <style>{CSS}</style>

      <div className="proto-bar">
        <span>
          <b>Prototype</b>not part of the design
        </span>
        <span>
          <b>State</b>
          <span className="proto-seg">
            {['ready', 'loading', 'empty', 'error', 'denied'].map((s) => (
              <button key={s} data-on={view === s} onClick={() => setView(s)}>
                {s}
              </button>
            ))}
          </span>
        </span>
        <span>
          <b>Viewing as</b>
          <span className="proto-seg">
            {people
              .filter((p) => p.role === 'super_admin')
              .map((p) => (
                <button key={p.id} data-on={viewerId === p.id} onClick={() => setViewerId(p.id)}>
                  {p.first}
                </button>
              ))}
          </span>
        </span>
      </div>

      <div className="page">
        <p className="crumb">Balo admin</p>
        <h1 className="h1">Staff access</h1>
        <p className="sub">
          Who can open the Balo admin area, and what they can do once they are in. Every change here
          is recorded against the person who made it.
        </p>

        {view === 'loading' && <Loading />}
        {view === 'empty' && <Empty onGiveAccess={() => setAddOpen(true)} />}
        {view === 'error' && <Failed onRetry={() => setView('ready')} />}
        {view === 'denied' && <NoAccess />}

        {view === 'ready' && (
          <div className="split">
            <div className="card">
              <div className="card-pad" style={{ paddingBottom: 12 }}>
                <input
                  className="roster-search"
                  placeholder="Search staff"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <ul className="roster-list">
                {shown.map((p) => (
                  <li key={p.id}>
                    <button
                      className="roster-item"
                      data-active={p.id === selectedId}
                      onClick={() => setSelectedId(p.id)}
                    >
                      <span className="avatar">{initials(p)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <div className="roster-name">
                          {fullName(p)}
                          {p.id === viewerId ? ' (you)' : ''}
                        </div>
                        <div className="roster-meta">
                          {p.role === 'super_admin' ? 'Super admin' : 'Admin'}
                          {p.capabilities ? ' · custom' : ''}
                        </div>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="count-line">
                <span>{people.length} with staff access</span>
                <button className="btn-link" onClick={() => setAddOpen(true)}>
                  Give someone access
                </button>
              </div>
            </div>

            <Detail
              key={selectedId}
              person={selected}
              viewerId={viewerId}
              people={people}
              onSave={(next) => setPeople((prev) => prev.map((p) => (p.id === next.id ? next : p)))}
            />
          </div>
        )}
      </div>

      {addOpen ? (
        <AddStaffDialog
          people={people}
          onClose={() => setAddOpen(false)}
          onPromote={handlePromote}
        />
      ) : null}
    </div>
  );
}
