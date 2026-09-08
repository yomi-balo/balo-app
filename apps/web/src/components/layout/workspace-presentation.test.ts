import { describe, it, expect } from 'vitest';
import type {
  ExpertWorkspace,
  MembershipCompanyWorkspace,
  RepresentationCompanyWorkspace,
} from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';
import {
  workspaceSubtitle,
  workspaceDisplayName,
  workspaceInitials,
  EXPERT_WORKSPACE_SUBTITLE,
  REPRESENTING_WORKSPACE_SUBTITLE,
  PERSONAL_WORKSPACE_SUBTITLE,
  REPRESENTATION_SWITCH_UNAVAILABLE_NOTE,
} from './workspace-presentation';

// BAL-507 — split into two builders rather than one `company()` with a default `role`. A
// default role would let `company({ via:'representation', isPersonal:true })` keep compiling
// and silently recreate `{ via:'representation', role:'owner' }` at runtime — exactly the
// illegal state the discriminated union exists to make unrepresentable. `Omit<…, 'type'|'via'>`
// makes it impossible to steer either helper onto the other arm.
function membershipCompany(
  overrides: Partial<Omit<MembershipCompanyWorkspace, 'type' | 'via'>> = {}
): MembershipCompanyWorkspace {
  return {
    type: 'company',
    key: 'company:11111111-1111-4111-8111-111111111111',
    companyId: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Industrial',
    via: 'membership',
    isPersonal: false,
    role: 'owner',
    ...overrides,
  };
}

function representationCompany(
  overrides: Partial<Omit<RepresentationCompanyWorkspace, 'type' | 'via'>> = {}
): RepresentationCompanyWorkspace {
  return {
    type: 'company',
    key: 'company:11111111-1111-4111-8111-111111111111',
    companyId: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Industrial',
    via: 'representation',
    isPersonal: false,
    ...overrides,
  };
}

const expert: ExpertWorkspace = EXPERT_WORKSPACE;

describe('workspaceSubtitle', () => {
  it('expert → "Expert workspace"', () => {
    expect(workspaceSubtitle(expert)).toBe(EXPERT_WORKSPACE_SUBTITLE);
  });

  it('representation AND isPersonal:true → "Client · Representing" (proves 2 beats 3)', () => {
    const workspace = representationCompany({ isPersonal: true });
    expect(workspaceSubtitle(workspace)).toBe(REPRESENTING_WORKSPACE_SUBTITLE);
  });

  it('personal AND role:owner → "Client · Personal" (proves 3 beats 4)', () => {
    const workspace = membershipCompany({ isPersonal: true });
    expect(workspaceSubtitle(workspace)).toBe(PERSONAL_WORKSPACE_SUBTITLE);
  });

  it('membership, non-personal, each role → the three exact strings', () => {
    expect(workspaceSubtitle(membershipCompany({ role: 'owner' }))).toBe('Client · Owner');
    expect(workspaceSubtitle(membershipCompany({ role: 'admin' }))).toBe('Client · Admin');
    expect(workspaceSubtitle(membershipCompany({ role: 'member' }))).toBe('Client · Member');
  });

  it('byte-exact "·" — a stray ASCII hyphen or different dot cannot slip through', () => {
    expect(workspaceSubtitle(membershipCompany({ role: 'member' }))).toBe('Client · Member');
  });
});

describe('workspaceDisplayName', () => {
  it('expert → the actor name', () => {
    expect(workspaceDisplayName(expert, 'Dana Lee')).toBe('Dana Lee');
  });

  it('company → workspace.name', () => {
    expect(
      workspaceDisplayName(membershipCompany({ name: 'Northwind Industrial' }), 'Dana Lee')
    ).toBe('Northwind Industrial');
  });
});

describe('workspaceInitials', () => {
  it('expert → the actor initials verbatim', () => {
    expect(workspaceInitials(expert, 'DL')).toBe('DL');
  });

  it("company 'Northwind Industrial' → 'NI'", () => {
    expect(workspaceInitials(membershipCompany({ name: 'Northwind Industrial' }), 'DL')).toBe('NI');
  });

  it("single token 'Globex' → 'G'", () => {
    expect(workspaceInitials(membershipCompany({ name: 'Globex' }), 'DL')).toBe('G');
  });

  it("three tokens 'Acme Widgets Co' → 'AC' (first+last)", () => {
    expect(workspaceInitials(membershipCompany({ name: 'Acme Widgets Co' }), 'DL')).toBe('AC');
  });

  it("'  spaced   out  ' → 'SO'", () => {
    expect(workspaceInitials(membershipCompany({ name: '  spaced   out  ' }), 'DL')).toBe('SO');
  });

  it("'' and '   ' → '?'", () => {
    expect(workspaceInitials(membershipCompany({ name: '' }), 'DL')).toBe('?');
    expect(workspaceInitials(membershipCompany({ name: '   ' }), 'DL')).toBe('?');
  });

  it('lower-case input upper-cases', () => {
    expect(workspaceInitials(membershipCompany({ name: 'northwind industrial' }), 'DL')).toBe('NI');
  });
});

describe('REPRESENTATION_SWITCH_UNAVAILABLE_NOTE', () => {
  it('is the exact shipped switcher string, byte-for-byte (incl. the U+2019 apostrophe)', () => {
    expect(REPRESENTATION_SWITCH_UNAVAILABLE_NOTE).toBe('Switching here isn’t available yet');
  });
});
