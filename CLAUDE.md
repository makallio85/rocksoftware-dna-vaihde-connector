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
- backend or preview/staging addresses, company or product names, issue or PR numbers
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
- Never change `key` in `manifest.json`: it fixes the extension ID
  (`fikiichepjhbdeclghchkglkfmpibgac`) that backends' connect links use.
- Call audio may go only to the providers `DVCConnect.isProviderStream()`
  allows; a connect link never replaces a connection to another backend.
  Keep both guards.

## Generic, not tied to one backend

The extension works with any backend that provides the API in the README.
Never name a specific backend, ERP or its menus, permissions or API paths in
code, UI text or docs. In Finnish UI text the backend is
"taustajärjestelmä"; in English code and docs "the backend". The API address
is the full base address the user enters.
