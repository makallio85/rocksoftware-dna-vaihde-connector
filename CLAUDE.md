# CLAUDE.md

Rules for working in this repository.

## Releases

- Every version that reaches users is a **GitHub Release with its zip**:
  raise `version` in `manifest.json` and `package.json`, commit, push the tag
  `v<version>`. The *Release* workflow tests, builds and publishes the zip.
  A release is not done until the Release page shows the zip.
- Never commit zip files.

## Public repository: keep it clean

This repository is public. Never commit:

- real phone numbers, names of real people, or customer data. Use made-up
  test data (e.g. `0401234567`, "Matti Meikäläinen");
- ERP addresses, preview/staging addresses, company names, issue or PR numbers
  of private repositories;
- tokens, keys or passwords;
- screenshots that show any of the above.

The only personal data allowed is the commit author's name and email.

## Code

- Plain JavaScript, no build step and no dependencies. Content scripts and the
  service worker load classic scripts; pure helpers live in `src/shared/` and
  are unit-tested in `test/shared.test.js` (`npm test`, or Node in Docker).
- User-facing text is Finnish.
- Internal names use the `dvc-` / `DVC` prefix.
