# ADR-0002: Licensing model

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

MindRail is intended to expose its implementation and architecture publicly while retaining a viable path for the original project to commercialize a hosted offering. The system is relatively reproducible from public architecture and source, so a fully permissive license would allow a third party to operate a competing managed service without contributing back.

The project also wants broad personal, research, self-hosted, and internal business adoption. A blanket non-commercial license would conflict with that adoption goal.

## Decision

1. MindRail releases use **Business Source License 1.1 (`BUSL-1.1`)** during the source-available period.
2. Repository/project language must say **source-available**, not OSI Open Source, until the applicable Change License takes effect.
3. The Additional Use Grant permits production use for personal/self-hosted deployments and internal business operations, including use of MindRail to operate a company's own products/services.
4. The Additional Use Grant does not permit offering MindRail's substantially equivalent orchestration/control-plane functionality to third parties as a competing commercial hosted, managed, or SaaS service without a separate commercial license.
5. Each release/version governed by BSL has a Change Date no later than the BSL maximum. The initial repository parameters use `2030-08-29`; this must be reviewed when the first public release is cut.
6. The intended Change License is **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)**, subject to legal confirmation before public release.
7. Before external contributions are accepted, contribution terms must preserve the project's ability to offer alternative commercial licensing. The exact CLA/DCO mechanism requires a separate governance decision.
8. The license text and project-specific grant receive legal review before the repository becomes public or commercial licenses are offered.

## Important limitation of this choice

BUSL-1.1 itself grants the right to redistribute the Licensed Work subject to BSL. Its Additional Use Grant can grant limited production rights; it cannot be used to add a new restriction to rights already granted by the standard BSL text.

Therefore this decision **does not create a blanket ban on commercial redistribution or copying**. Its primary protection is control over production use outside the Additional Use Grant, especially a competing hosted/managed service. A third party may redistribute BSL-covered copies, but recipients remain bound by the applicable BSL terms and cannot simply relicense the combined work under a permissive license.

If the project later requires a blanket prohibition on all commercialization without licensor approval, BUSL-1.1 is not sufficient and this ADR must be superseded by a different licensing model.

## Alternatives considered

### Apache-2.0

Rejected for the initial phase. Excellent for adoption and patent clarity, but permits competing hosted commercialization with no obligation to open modifications.

### AGPL-3.0-or-later immediately

Deferred as the eventual open-source direction. It keeps network modifications available but does not prevent a compliant third party from operating a competing commercial service.

### Blanket non-commercial/custom license

Rejected for now. It would better restrict commercialization but would also complicate internal business adoption, ecosystem compatibility, and the project's ability to use the standardized BSL expectations.

## Consequences

- MindRail must not market itself as open source during the BSL period.
- Internal company use can remain frictionless under the Additional Use Grant.
- Competing managed-service use is the primary commercial-license boundary.
- License parameters must be reviewed per public release/version.
- Contributor copyright/licensing mechanics become important before opening external contributions.
- License headers/SPDX metadata added later must match this ADR and `LICENSE`.

## Compatibility and migration

No previously published MindRail release exists to migrate. Future changes to the usage grant apply prospectively to new releases; already distributed versions retain their existing license terms.
