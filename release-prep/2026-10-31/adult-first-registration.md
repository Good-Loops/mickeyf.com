# Adult-first registration preparation

This change prepares a temporary adult-only signup phase for the reviewed United States and Brazil registration rules. Parent-led child creation remains closed. It does not claim the child consent process is complete.

`REGISTRATION_ADULT_ONLY=true` requires the child-audience age policy and refuses a simultaneously enabled parent-creation flag. The server records an underage observation before rejecting the signup preflight and independently rejects any older minor authorization at credential verification and inside the account-creation transaction. The existing eligibility result and public configuration formats remain compatible with the current client protocol. Web age entry remains self-declared; the screening is not proof of identity or age.

Parent management may retain its previously configured signed-form countries while adult signup covers a broader reviewed registration country set. This does not mark any additional child-consent country as reviewed. The complete signed-form country coverage and schema requirements still apply before child creation can be enabled.

The guarded release tooling recognizes `prepare-adult` and `active-adult`: both require adult-only enforcement, keep parent creation closed, and require the same complete policy for the zero-traffic preparation, active revision and closed fallback. The existing child-creation activation and its separate schema evidence remain unchanged.

Before a live rollout, obtain current exact-source build and CI results; verify the production configuration, legacy schema, grants, website and backend rollback targets; and exercise the paired website/backend behavior in a faithful preview. Validate password and provider sign-in and the intended device builds. A zero-traffic readiness result or a unit test alone is not evidence that the public signup experience works. Do not apply the child schema migration merely to open adult signup.
