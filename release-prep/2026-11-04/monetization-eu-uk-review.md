# Monetization and Europe/UK preparation — 4 November 2026

This completes the **requirements review** in release item 1.4. It does not enable
payments, advertising, additional countries or attest that those future flows
are ready. Implementation and final terms remain under 4.3 and their existing
privacy, build and store gates.

## Owner decisions and observed store settings

- Intended audience: approximately **10-30 years old**, including children,
  teens and young adults. This supersedes the earlier description of adults in
  their twenties/thirties as the primary audience.
- First release: **free, without ads**. The owner explicitly deferred advertising
  and a paid ad-free upgrade to a later update. Prepare that model now; do not
  add ad or billing SDKs to the current candidate.
- Future model: a free ad-supported version plus a paid ad-free upgrade. A
  one-time non-consumable upgrade is the recommended implementation assumption;
  price, platforms, eligible countries and entitlement sharing remain undecided.
  A subscription would need a separate owner choice and recurring-payment terms.
- Google Play readback: target bands 9-12, 13-15, 16-17 and 18+ are selected in
  an **unfinished** declaration. Saved content ratings: Brazil 10+, ESRB Everyone
  10+, PEGI 7, Germany USK 12+. Different rating systems need not agree. Saved Ads
  answer: No. Neither age suitability nor a draft selection proves compliance.
- App Store Connect readback: 13+ in 172 countries/regions; Brazil 12+, South
  Korea 12+, Vietnam 16+. Earlier-than-version-26 operating systems show global
  12+ with regional exceptions. Categories: Entertainment and Music. The app is
  not being presented as a Kids Category release. Rating questionnaires must
  continue to reflect the content; the intended 10-30 audience does not override
  Apple's stricter regional suitability ratings.

## Changes required for the selected monetization model

| Area | Required behavior before ads or the upgrade launch |
| --- | --- |
| Ad SDK and inventory | Select and review the exact provider/SDK versions, network partners, data flows, contract, consent controls and retention. For children/unknown ages, use only qualifying Families ad SDKs and child-appropriate ads; no personalized ads or restricted device identifiers. A network's general approval is not approval of every SDK version or configuration. |
| Age and guest handling | Apply protections before any ad SDK starts, including signed-out guests and uncertain ages. The existing account-registration screen alone does not protect someone who can reach guest games first. Use contextual ads as the baseline; do not make a child purchase privacy protections. |
| Paid removal | Offer purchases through the applicable Apple/Google digital-goods billing route. Verify entitlement server-side where needed; restore purchases after reinstall/device change; handle pending, cancelled, refunded and revoked transactions. Stop ad loading for entitled users. Decide family/account/platform portability and explain it before purchase. |
| Consumer terms | State operator/contact, exact price/currency/tax treatment, what is removed, duration, compatibility, restoration, support/refunds and statutory rights. Do not sell “lifetime” access without defining its scope. Separate privacy choices and parental permission from purchase assent. |
| Child purchase design | Use appropriate parent controls/gates, clear pricing and readable purchase language. No pressure to buy, deceptive close buttons, disguised ads or reward/penalty patterns that exploit children. |
| Disclosures and validation | Update both language notices, SDK inventories, Data safety, App Privacy, Ads and relevant rating answers from the implemented build. Recheck network behavior before consent, for children/unknown ages, and after purchasing/restoring ad removal. |

Google requires truthful age selection based on actual design, not simply a wish
to permit every age. Its Families rules cover ads and data from children and
unknown-age users. [Audience guidance](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en),
[Families policy](https://support.google.com/googleplay/android-developer/answer/9893335?hl=en).
Use the applicable storefront rules rather than assuming a web payment link is
permitted everywhere. [Play payments](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en),
[Apple review guidelines, sections 1.3 and 3](https://developer.apple.com/app-store/review/guidelines/).

## Europe and UK expansion requirements

| Topic | What must change or be settled before expansion |
| --- | --- |
| Territories and child consent | Choose exact countries and languages. Map lawful bases by purpose and country. For consent-based online services, EU parent-consent thresholds vary from 13 to 16; the UK's threshold is 13. These are not universal permission-to-use ages. Qualify guardian verification and correction/withdrawal routes for the chosen countries. Do not reuse BR/US flags as an EU/UK approval. |
| Privacy and children's design | Produce an age-appropriate privacy explanation and documented child-risk/DPIA review. Apply high privacy defaults, minimization, clear parental-control information and accessible rights tools. Review the UK's Children's Code because children are part of the audience. Assess relevant EU/UK representative and supervisory-contact obligations for a Brazil-based operator. |
| Tracking | Assess storage/access rules for ads and email pixels separately from permission to send an account notice. Anonymous reporting alone does not establish a consent exemption. Keep essential warning delivery available without making optional tracking consent compulsory; qualify the actual provider configuration for these territories. |
| Providers and transfers | Complete the actual processor/controller and transfer records, applicable contractual mechanisms, security assurances, retention and deletion disclosures. EU adequacy for Brazil does not settle every US or other onward transfer. |
| Consumer purchases | Provide the required pre-contract information, durable purchase confirmation, digital-content/service remedies, and withdrawal/refund handling. Immediate digital supply does not automatically waive withdrawal rights; obtain the applicable express agreement/acknowledgement. Store handling must be reconciled with Ludolume's own terms and support process. |
| Public features and safety | Assess the actual public nickname/leaderboard features for EU intermediary/platform and UK user-to-user scope. No chat does not by itself establish an exemption. If in scope, complete the relevant reporting, moderation and child-access/risk duties before enabling those features there. |
| Store and commercial setup | Finish Apple's EU Trader declaration as applicable; Google's Trader entry alone does not cover Apple. Confirm approved public contacts, local prices, tax/payment arrangements and the chosen territories; then submit the accurate app declarations. |

Sources: [EU child-consent explanation](https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en),
[ICO lawful bases for children](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/children-and-the-uk-gdpr/how-do-the-lawful-bases-apply-to-children-s-personal-information/),
[ICO Children's Code](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/code-standards/),
[ICO storage/access technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/),
[EU distance-selling duties](https://europa.eu/youreurope/business/selling-in-eu/selling-goods-services/ecommerce-distance-selling/index_en.htm),
[digital-content remedies](https://eur-lex.europa.eu/eli/dir/2019/770/oj),
[Ofcom gaming scope](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/the-online-safety-act-and-gaming-know-the-risks-know-the-rules-know-how-to-comply).

If the owner later selects recurring payments, also review current renewal,
reminder, easy-cancellation and cooling-off requirements, including the UK's
[subscription-contract guidance](https://www.gov.uk/government/publications/subscription-contracts).
Do not copy subscription commitments into a one-time upgrade's terms.

The next launch remains BR/US, free and without ads. This review records the
future requirements so monetization and territorial expansion do not silently
change the current release. Recheck applicable rules when the future build is
actually prepared; a dated requirements review is not permanent approval.
