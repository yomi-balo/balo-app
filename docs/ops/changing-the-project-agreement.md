# Changing the Projects agreement

The Balo Projects Master Services Agreement lives in code: `apps/web/src/lib/legal/project-terms.ts`. Each published version is frozen as a PDF under `apps/web/public/legal/`, listed in `apps/web/src/lib/legal/project-terms-versions.json`, and recorded on every proposal acceptance.

## Steps

1. Edit the wording in `project-terms.ts` in a PR.
2. Set `PROJECT_TERMS_VERSION` to the new date (ISO, later than the last listed version) and update `PROJECT_TERMS_LAST_UPDATED_LINE`.
3. Run `pnpm --filter web legal:publish`. It regenerates `docs/legal/project-terms.md`, renders the new PDF and appends the version entry.
4. Commit the new PDF, the version entry and the regenerated `docs/legal/project-terms.md`.
5. MJ approves the PR by reading the `docs/legal/project-terms.md` diff.

## Notes

- CI fails until `legal:publish` has run: the guard test compares the text's fingerprint with the listed entry, and the Markdown snapshot test compares the generated file.
- A listed PDF or version entry is never edited. If the text of a listed version changes, `legal:publish` refuses; set a new `PROJECT_TERMS_VERSION` instead.
- The first PR that changes wording also deletes `project-terms.parity.test.ts` and `docs/legal/balo-projects-msa.md`.
