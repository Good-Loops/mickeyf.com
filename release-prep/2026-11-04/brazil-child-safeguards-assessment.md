# Ludolume: Brazil child-safeguards assessment

Reviewed 5 November 2026 for the intended free, no-advertising first release.
This is a product-specific engineering assessment, not a legal approval or
evidence that an undeployed control is operating. It supports release item 1.3;
it does not close that item or the device checks in 1.2.

## Scope and assessment

The owner describes the intended audience as roughly ages 10–30. Ludolume offers
games and connected accounts and is intended to be accessible to minors. Treat
Brazilian child and adolescent protections as relevant to the release; an
adult-account gate alone is not a reason to exclude guest access or the rest of
the product from review. The ANPD's October 2026 guide says an express youth
audience can establish direction to minors; otherwise its likely-access test
considers attraction, ease of access and significant risk together. An age gate
does not by itself remove a product from scope. This is a conservative
engineering assessment, not a binding determination by ANPD.

Review the actual product and supported website, iOS and Android flows together.
The table distinguishes candidate source, operating evidence and unresolved
risks. A signed-form method is not proof of guardianship merely because a parent
controls a provider account. No real child data is needed for qualification.

| Risk and foreseeable impact | Existing evidence / control | Remaining release evidence or action |
| --- | --- | --- |
| An ineligible user enters an adult path or a parent is excluded incorrectly. | Candidate converts entered age to a broad category; native Apple/Play range signals and protective conflict handling are implemented. Parent-led creation is currently closed. | Verify real supported-device signals, denied/unavailable ranges, browser behavior and correction path. Assess proportionality and current ANPD age-assurance guidance; do not collect identity documents by default. |
| An adult cannot validly authorize a managed account, or a child is exposed before authorization. | Candidate binds the signed form to the verified parent contact, request, country and policy; private child credentials follow approval. Manual matched/mismatched, expiry and withdrawal cases were rehearsed in 2.3. | Qualify the live Brazil flow and reasonable guardian checks in 2.4, including denied and correction cases; keep creation closed meanwhile. Provider sign-in verifies account control, not parenthood. |
| Public nickname or scores expose a child, or user-provided content causes harm. | Candidate notice says new scores are private by default and public participation is separately optional; parents can withdraw it. Existing-account visibility is not covered by that new-account promise. | Verify default, opt-in, withdrawal and legacy behavior against the released version. Assess the actual nickname/content and reporting surface and moderation proportionately; do not assume there are no harmful strings or interactions merely because no chat was identified in this review. |
| Sensitive form, account or result data is exposed, retained too long or revived after deletion. | Encrypted form storage, owner review and synthetic cleanup/recovery were qualified in 2.2–2.3. Cloud SQL recovery remains available; guard-aware cleanup has isolated rehearsals but is not yet operational. | Finish provider roles/transfers, finite enforceable retention, all-copy cleanup and recovery-safe journal retirement. Keep unresolved deletion/restore cases held; do not present proposed schedules as existing guarantees. |
| Parent or child cannot understand the processing, risks or available safeguards. | Candidate notice, signed form and parent controls include Portuguese; consent/form version binding is implemented in source. | Verify understandable Portuguese text and control availability on final devices and deployed policy versions; provide accessible risk and safety information without requiring a purchase. Do not treat source translation as deployed proof. |
| Engagement design contributes to excessive use or weakens informed choices. | First release is planned without advertising or an ad-free purchase. | Inspect actual game loops, notifications, autoplay, rewards and interface choices. Verify age-appropriate usage information, supervision notices and time-limiting/monitoring arrangements applicable to the real product. Articles 17–18 list these functions, subject to the modulation in article 39; an OS link alone has not been qualified as sufficient. Avoid collecting new child telemetry until its necessity and privacy consequences are assessed. |
| Security, account recovery or provider failure exposes users or prevents a parent from acting. | Scoped cloud access, tested private form recovery and a recovery-aware audit exist; the production checkpoint and recovery cutover are not finished. | Establish the operator's security-program responsibility, incident and provider response, and the tested recovery/retention procedure. Verify practical parent contact and access on the released system. |

Likelihood and impact require actual product and device observations; this table
does not invent risk scores or claim that the remaining risks are mitigated.
Revisit it when audience, interactions, data flows or monetization change. Ads,
targeting, billing, a social/chat feature or a new engagement mechanic require a
new assessment before activation; they are not part of the first release plan.

## Primary sources

- [ANPD, ECA Digital general scope and duties guide, October 2026](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-fornecedores-de-produtos-ou-servicos-de-tecnologia-da-informacao.pdf/@@display-file/file), especially pp. 29–34 and 43–58. It addresses scope and general duties, not a complete product-specific age-assurance or parental-controls specification.
- [Lei 15.211/2025, current text, Câmara dos Deputados](https://www2.camara.leg.br/legin/fed/lei/2025/lei-15211-17-setembro-2025-797997-normaatualizada-pl.html), especially arts. 5–8, 12–18 and 39.
- [Decreto 12.880/2026, Câmara dos Deputados](https://www2.camara.leg.br/legin/fed/decret/2026/decreto-12880-18-marco-2026-798813-publicacaooriginal-178481-pe.html), including its age-assurance and risk provisions.
- [ANPD ECA Digital portal](https://www.gov.br/anpd/pt-br/assuntos/eca-digital/) for the evolving age-assurance implementation and regulatory timetable. Verify the current final instrument rather than treating the general guide as the final age-assurance guidance.

Local evidence: `child-privacy-review.md`, `retention-provider-review.md`,
`security-retention-program.draft.md`, the release plan and the 2.2–2.3
qualification receipts. Some older statements in those historical documents
are superseded by their dated checkpoints and the current release plan.
