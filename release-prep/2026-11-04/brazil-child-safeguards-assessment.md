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
| Engagement design contributes to excessive use or weakens informed choices. | First release is planned without advertising or an ad-free purchase. Candidate game and animation source is reviewed below. | Verify the actual final-build behavior, notifications, autoplay, rewards and interface choices. Verify age-appropriate usage information, supervision notices and time-limiting/monitoring arrangements applicable to the real product. Articles 17–18 list these functions, subject to the modulation in article 39; an OS link alone has not been qualified as sufficient. Avoid collecting new child telemetry until its necessity and privacy consequences are assessed. |
| Security, account recovery or provider failure exposes users or prevents a parent from acting. | Scoped cloud access, tested private form recovery and a recovery-aware audit exist. On 5 November the owner accepted the security-program coordinator role; the production checkpoint and recovery cutover are not finished. | Complete the incident and provider response and the tested recovery/retention procedure. Verify practical parent contact and access on the released system. |

## Product features relevant to usage and supervision

Source review on 5 November, not a claim about deployed or device behavior:

- p4-Vega starts its game runner on the game page. A run ends in a result
  screen with a score, possible personal-best feedback and a user-initiated
  replay action; keyboard and canvas-tap restart paths also exist. The page has
  a pause control, but that is not a parent-set usage limit.
- The Three Bosses source has pause/resume and return-to-menu controls, as well
  as a results screen with retry and score-submission actions. Its availability
  remains subject to the actual release gate.
- The animation pages start visual rendering when mounted and expose controls
  for user-selected audio. The inspected pages do not establish a parent-set
  time limit or consolidated usage report. A search of the relevant native app
  and game source did not find a push-notification implementation; that limited
  search is not proof of the complete runtime or third-party SDK behavior.

These engagement and replay features merit a proportionate assessment; they do
not by themselves establish compulsive design. The present source review found
no qualified parent-controlled limit or consolidated usage view. The Brazilian
law describes usage limiting and monitoring, visible notices and Portuguese
controls, with the modulation in article 39. The ANPD also lists absence of
time-limiting and monitoring functionality as a potential complaint. Apple
Screen Time and Google Family Link offer some device/app controls, but their
availability and coverage of web, guest and offline use must be verified; links
to those products alone are not evidence that Ludolume's obligations are met.
The owner chose to prepare an optional parent-set daily limit and a daily total
for managed child accounts. The candidate stores one current aggregate and a
time zone per child, rather than a history of individual actions. A short
foreground lease can overcount by up to 30 seconds after disconnection.
Turning the control off removes its setting and current total. An unscheduled
draft cleanup can clear stale totals while retaining the setting. These pieces
have local tests but are not integrated or deployed; the retention schedule,
recovery copies, parent consent/disclosures and device behavior need review.
The candidate does not cover signed-out guest use, offline use or other apps.

### Draft disclosure for review, not the active notice

**English:** If you set a daily limit for a managed child account, we store the
limit, its time zone and one daily usage total to show and apply the control.
Use is estimated while the account is online and may include up to 30 seconds
after a connection ends. Turning off the control removes its setting and
current total. It does not limit guest use, offline use or other apps. Recovery
copies and the actual retention deadline still need to be confirmed.

**Português:** Se você definir um limite diário para uma conta infantil
supervisionada, armazenaremos o limite, seu fuso horário e um total diário de
uso para mostrar e aplicar o controle. O uso é estimado enquanto a conta está
online e pode incluir até 30 segundos após o fim da conexão. Desativar o
controle remove a configuração e o total atual. Ele não limita o uso como
visitante, offline ou em outros aplicativos. As cópias de recuperação e o prazo
real de retenção ainda precisam ser confirmados.

Before using this text, qualify the actual data flow and retention and decide
whether a new parent permission and signed-form version are required. Do not
change an existing signed consent silently.

Sources: [Brazilian Senate, Law 15.211/2025, arts. 17–18 and 39](https://legis.senado.leg.br/norma/41465823/publicacao/41471709),
[ANPD complaint examples](https://www.gov.br/anpd/pt-br/assuntos/eca-digital/denuncias-eca-digital),
[Apple parental controls](https://support.apple.com/en-us/105121), and
[Google Family Link time limits](https://support.google.com/families/answer/7103340?hl=en).

## Preliminary impact assessment

The following are working judgments for design and verification, not measured
incident rates or a final legal determination. No launch-user or child data was
used to estimate likelihood. "Possible" means the scenario is technically or
operationally plausible; its actual frequency is unknown.

| Scenario | Likelihood and potential severity | Current treatment and remaining evidence |
| --- | --- | --- |
| A young user keeps playing longer than intended. | Possible: the source offers replay and continuous visuals; frequency and health effects are unknown and vary by child. | Pause and leaving the page are available in source. Parent-controlled time limits, usage information and final-device behavior remain unqualified. |
| A child uses an adult path or an adult is incorrectly denied. | Possible when entered age and device signals are unavailable or inaccurate; potential harm includes exposure or loss of access to an appropriate service. | Protective age-signal handling exists in the candidate. Verify supported devices, guest use and correction/support paths; do not assume self-declaration establishes age. |
| A nickname or result is shown without the intended permission. | Possible if legacy settings, authorization or withdrawal fail; exposing identifying text can have serious privacy consequences. Frequency is unknown. | New managed accounts are designed for private scores and separate public permission. Verify legacy visibility, parental authorization, withdrawal and the live paths before release. |
| A form, account record or restored copy is exposed or revives deleted information. | Possible through access, operator or recovery failure; exposure or resurrection can seriously affect privacy. Frequency is unknown. | Encrypted form storage and synthetic cleanup were tested; keep the restore guard held until recovery, retention and provider-copy handling are qualified. |

Before publishing a summary or closing 1.3, resolve the open treatments, assess
their residual risk with the released behavior and operating evidence, and set
an owner review after material changes and incidents. A public version must
describe only controls actually available to users, in accessible language.

Likelihood and impact require actual product and device observations; this table
does not invent risk scores or claim that the remaining risks are mitigated.
Article 47 of Decree 12.880/2026 describes a safety and health impact assessment,
including likelihood, potential severity, mitigation and ongoing effectiveness,
and calls for a clear public summary. This source review is not yet that final
assessment or public summary. [Brazilian Senate, decree art. 47](https://legis.senado.leg.br/norma/42908005/publicacao/42908281).
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
