# Public Release Checklist

This checklist records the initial transition of MindRail from private to public development.

## Before visibility change

- [x] Review the reachable repository tree/history for credentials, tokens, private keys, personal secrets, and unintended personal data. No obvious credential-like material was found in the final foundation change; the working branch was rewritten to one clean foundation commit before publication.
- [x] Confirm `LICENSE` contains the standard BUSL-1.1 body separately from MindRail-specific parameters. The standard body was compared with the SPDX-published BUSL-1.1 text.
- [x] Confirm README/project wording describes MindRail as source-available under BUSL-1.1, not OSI Open Source during the BSL period.
- [x] Review open issues, pull request #1, reachable commit messages, and current documentation for information that should not become public.
- [x] Confirm permanent CI requests only read access and references no production credentials.
- [x] Maintainer authorized public repository visibility to unblock development and understands that MindRail-specific BUSL parameters have not received professional legal review.

## Legal follow-up

Professional review of the Additional Use Grant, licensor identity, Change Date/Change License compatibility, and future contribution/dual-licensing mechanics remains required before relying on those terms for material commercial enforcement. Publication is not legal validation.

## After visibility change

- [x] Observe a real GitHub-hosted `Quality` job receiving a runner.
- [x] Generate and commit `pnpm-lock.yaml` using Node 24 and pinned pnpm 11.24.0.
- [x] Run the full `pnpm check` gate successfully in GitHub Actions.
- [x] Run `pnpm test:coverage` successfully without inventing a coverage threshold.
- [ ] Enable minimal `main` branch protection/ruleset: PR required, `Quality` required, force-push/deletion blocked, conversation resolution required.
- [ ] Verify with a test PR that missing/failing `Quality` actually blocks merge.
- [x] Reconcile `docs/CURRENT_STATE.md` and PR #1 with fresh execution evidence.

Repository visibility alone is never evidence that CI or branch protection is working.
