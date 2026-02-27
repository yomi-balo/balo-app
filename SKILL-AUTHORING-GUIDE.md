# Skill Authoring Guide for Balo

Based on Anthropic's official documentation and best practices.
Sources: platform.claude.com/docs, support.claude.com, github.com/anthropics/skills

---

## Key Takeaways from Anthropic's Official Guidance

### 1. SKILL.md Structure (Required)

Every skill needs YAML frontmatter with exactly two fields:

```yaml
---
name: workos-auth
description: WorkOS AuthKit integration patterns for Balo. Use when implementing authentication, session handling, protected routes, middleware, or user management. Covers sign-up, sign-in, role-based access, and WorkOS webhook handling.
---
```

**Rules:**

- `name`: max 64 chars, lowercase + hyphens only, no "anthropic" or "claude"
- `description`: max 1024 chars, write in **third person**, be specific about triggers
- Description is the PRIMARY triggering mechanism — make it "pushy" so Claude doesn't under-trigger

### 2. Conciseness Is Critical

The context window is shared. Every token in a skill competes with conversation history.

**Default assumption: Claude is already very smart.**
Only include information Claude doesn't already know. For Balo skills, this means:

- ✅ Balo-specific patterns (our auth middleware shape, our RLS conventions)
- ✅ Decision rationale that's non-obvious (why we use Drizzle not Prisma)
- ❌ Generic explanations of what WorkOS is or how RLS works

**Target: SKILL.md body under 500 lines.** Push detailed content to reference files.

### 3. Progressive Disclosure

```
skill-name/
├── SKILL.md              # Overview + navigation (loaded when triggered)
├── references/
│   ├── patterns.md       # Code patterns (loaded on demand)
│   ├── examples.md       # Real examples (loaded on demand)
│   └── api-reference.md  # API details (loaded on demand)
└── scripts/              # Utility scripts (executed, not loaded)
```

- SKILL.md is level 1 — loaded when skill triggers
- Reference files are level 2 — loaded only when Claude needs them
- Keep references ONE level deep from SKILL.md (no nested references)
- For files >100 lines, include a table of contents at the top

### 4. Set Appropriate Degrees of Freedom

Match specificity to how fragile the operation is:

- **High freedom** (text instructions): Code reviews, architecture decisions
- **Medium freedom** (templates with params): API route patterns, component structure
- **Low freedom** (exact scripts): Database migrations, RLS policies, webhook verification

For Balo:

- RLS policies → LOW freedom (exact patterns, no improvisation)
- Auth middleware → LOW freedom (security-critical)
- UI components → MEDIUM freedom (follow Shadcn patterns but adapt)
- Feature architecture → HIGH freedom (context-dependent)

### 5. Feedback Loops

For quality-critical operations, include validate → fix → repeat cycles:

```
1. Write schema
2. Run: drizzle-kit generate
3. Review migration SQL
4. If issues → fix schema → go to step 2
5. Only proceed when migration is clean
```

### 6. Iterative Development

**Build evaluations BEFORE writing documentation.**

1. Try the task without a skill — document where Claude fails
2. Write minimal skill to address those failures
3. Test with a fresh Claude instance
4. Iterate based on observed behavior

### 7. What NOT to Include

- Time-sensitive information (use "old patterns" sections if needed)
- Generic explanations Claude already knows
- Multiple options when one default is sufficient
- Windows-style paths (always use forward slashes)
- Deeply nested file references

---

## Applying This to Balo Skills

### Skill Priority (build these first)

1. **drizzle-schema** — every feature touches the DB
2. **supabase-rls** — every table needs security
3. **workos-auth** — every feature needs auth
4. **balo-ui** — every feature has UI
5. **fastify-api** — API route patterns
6. **stripe-connect** — payment features
7. **bullmq** — async job patterns

### Recommended Structure Per Skill

```
.claude/skills/workos-auth/
├── SKILL.md                    # ~200-400 lines
│   ├── Frontmatter (name + description)
│   ├── Quick reference (most common patterns)
│   ├── Decision tree (which pattern to use when)
│   └── Pointers to reference files
├── references/
│   ├── middleware-patterns.md   # Auth middleware code
│   ├── webhook-handling.md      # WorkOS webhook patterns
│   └── session-management.md    # Session handling patterns
└── scripts/                     # (if applicable)
    └── verify-auth-setup.sh     # Validation script
```

### Description Writing Guide

Descriptions should be third-person and "pushy" about triggering:

**Good:**

```
description: Implements Balo's WorkOS AuthKit authentication patterns including middleware, session handling, and protected routes. Use when creating any authenticated route, API endpoint, server action, or webhook handler. Also use when working with user roles (client/expert), sign-up/sign-in flows, or session management.
```

**Bad:**

```
description: WorkOS auth patterns for the project.
```

### Content Strategy Per Skill

For each Balo skill, content should come from:

1. **Official framework docs** — current API patterns, correct usage
2. **Balo architecture decisions** — our specific conventions and why
3. **Real code from the repo** — actual patterns as they emerge
4. **Gotchas discovered during development** — things that went wrong

### Agent ↔ Skill Integration

Our agents (architect, dba, build, review, secure, ux) reference skills.
Each agent prompt should:

- List which skills are relevant to its domain
- Instruct the agent to READ skills before acting
- Instruct the agent to FLAG deviations from skill patterns

---

## Checklist Before Shipping a Skill

- [ ] YAML frontmatter has name (≤64 chars) and description (≤1024 chars)
- [ ] Description is third-person and includes trigger contexts
- [ ] SKILL.md body is under 500 lines
- [ ] Only includes info Claude doesn't already know
- [ ] Detailed content pushed to reference files
- [ ] Reference files are one level deep (no nesting)
- [ ] Code examples are Balo-specific (not generic)
- [ ] Consistent terminology throughout
- [ ] Tested with a fresh Claude instance on real tasks
- [ ] Freedom level matches operation fragility
