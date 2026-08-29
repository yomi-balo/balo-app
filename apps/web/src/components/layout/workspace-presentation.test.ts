import { describe, it, expect } from 'vitest';
import type { CompanyWorkspace, ExpertWorkspace } from '@balo/shared/workspaces';
import { EXPERT_WORKSPACE } from '@balo/shared/workspaces';
import {
  workspaceSubtitle,
  workspaceDisplayName,
  workspaceInitials,
  EXPERT_WORKSPACE_SUBTITLE,
  REPRESENTING_WORKSPACE_SUBTITLE,
  PERSONAL_WORKSPACE_SUBTITLE,
  PLAIN_CLIENT_SUBTITLE,
} from './workspace-presentation';

function company(overrides: Partial<CompanyWorkspace> = {}): CompanyWorkspace {
  return {
    type: 'company',
    key: 'company:11111111-1111-4111-8111-111111111111',
    companyId: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Industrial',
    via: 'membership',
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
    const workspace = company({ via: 'representation', isPersonal: true });
    expect(workspaceSubtitle(workspace)).toBe(REPRESENTING_WORKSPACE_SUBTITLE);
  });

  it('representation AND an (illegally) present role → still "Client · Representing"', () => {
    const workspace = company({ via: 'representation', role: 'owner' });
    expect(workspaceSubtitle(workspace)).toBe(REPRESENTING_WORKSPACE_SUBTITLE);
  });

  it('personal AND role:owner → "Client · Personal" (proves 3 beats 4)', () => {
    const workspace = company({ isPersonal: true, role: 'owner' });
    expect(workspaceSubtitle(workspace)).toBe(PERSONAL_WORKSPACE_SUBTITLE);
  });

  it('membership, non-personal, each role → the three exact strings', () => {
    expect(workspaceSubtitle(company({ role: 'owner' }))).toBe('Client · Owner');
    expect(workspaceSubtitle(company({ role: 'admin' }))).toBe('Client · Admin');
    expect(workspaceSubtitle(company({ role: 'member' }))).toBe('Client · Member');
  });

  it('membership, non-personal, role:undefined → "Client"', () => {
    const workspace = company({ role: undefined });
    expect(workspaceSubtitle(workspace)).toBe(PLAIN_CLIENT_SUBTITLE);
  });

  it('byte-exact "·" — a stray ASCII hyphen or different dot cannot slip through', () => {
    expect(workspaceSubtitle(company({ role: 'member' }))).toBe('Client · Member');
  });
});

describe('workspaceDisplayName', () => {
  it('expert → the actor name', () => {
    expect(workspaceDisplayName(expert, 'Dana Lee')).toBe('Dana Lee');
  });

  it('company → workspace.name', () => {
    expect(workspaceDisplayName(company({ name: 'Northwind Industrial' }), 'Dana Lee')).toBe(
      'Northwind Industrial'
    );
  });
});

describe('workspaceInitials', () => {
  it('expert → the actor initials verbatim', () => {
    expect(workspaceInitials(expert, 'DL')).toBe('DL');
  });

  it("company 'Northwind Industrial' → 'NI'", () => {
    expect(workspaceInitials(company({ name: 'Northwind Industrial' }), 'DL')).toBe('NI');
  });

  it("single token 'Globex' → 'G'", () => {
    expect(workspaceInitials(company({ name: 'Globex' }), 'DL')).toBe('G');
  });

  it("three tokens 'Acme Widgets Co' → 'AC' (first+last)", () => {
    expect(workspaceInitials(company({ name: 'Acme Widgets Co' }), 'DL')).toBe('AC');
  });

  it("'  spaced   out  ' → 'SO'", () => {
    expect(workspaceInitials(company({ name: '  spaced   out  ' }), 'DL')).toBe('SO');
  });

  it("'' and '   ' → '?'", () => {
    expect(workspaceInitials(company({ name: '' }), 'DL')).toBe('?');
    expect(workspaceInitials(company({ name: '   ' }), 'DL')).toBe('?');
  });

  it('lower-case input upper-cases', () => {
    expect(workspaceInitials(company({ name: 'northwind industrial' }), 'DL')).toBe('NI');
  });
});
