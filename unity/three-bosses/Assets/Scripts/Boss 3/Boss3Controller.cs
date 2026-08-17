using System.Collections;
using UnityEngine;

public sealed class Boss3Controller : MonoBehaviour, IBossEffectReceiver
{
    private enum State
    {
        WaitingToAttack,
        Attacking,
        Hurt,
        Cooldown,
        Dead
    }

    private enum AttackType
    {
        Missile,
        Rune
    }

    [Header("References")]
    [SerializeField] private Boss3MovementController movement;
    [SerializeField] private Boss3MissileAttack missileAttack;
    [SerializeField] private Boss3RuneAttack runeAttack;
    [SerializeField] private Animator animator;
    [SerializeField] private HealthComponent health;

    [Header("Hurt")]
    [SerializeField] private float hurtLockSeconds = 0.35f;
    [SerializeField] private string hurtTriggerName = "Hurt";

    [Header("Death")]
    [SerializeField] private BossRemains remainsPrefab;
    [SerializeField] private Transform remainsSpawnPoint;
    [SerializeField] private Sprite deathRemainsSprite;
    [SerializeField] private Collider2D solidCollider;
    [SerializeField] private SpriteRenderer spriteRenderer;

    private bool isDead;

    [Header("Attack Timing")]
    [SerializeField] private float timeBeforeAttack = 2.0f;
    [SerializeField] private float missileAttackDuration = 1.2f;
    [SerializeField] private float runeAttackDuration = 1.3f;
    [SerializeField] private float cooldownAfterAttack = 0.6f;

    [Header("Attack Selection")]
    [SerializeField] private bool isPhaseTwo = false;
    [SerializeField, Range(0.1f, 0.9f)] private float phaseTwoHealthThreshold = 0.5f;
    [SerializeField] private float runeAttackChance = 0.35f;

    [Header("Freeze Visuals")]
    [SerializeField] private SpriteRenderer freezeTintRenderer;
    [SerializeField] private Color freezeTintColor = new(0.0f, 0.45f, 1f, 1f);
    [SerializeField] private float freezeTintLerpSpeed = 2.5f;

    private Color originalFreezeTintColor;
    private float currentFreezeTintAmount;

    private State state = State.WaitingToAttack;
    private float nextHurtThreshold = 0.9f;
    private Coroutine hurtRoutine;
    private float timer;
    private AttackType currentAttackType;
    private int lastKnownHealth = -1;
    private int lastKnownMaxHealth = -1;

    private bool isFrozen;
    private bool isAnchored;

    private Coroutine freezeRoutine;
    private Coroutine freezeTintRoutine;
    private Coroutine anchorRoutine;

    private bool IsEffectLocked => isFrozen || isAnchored;

    private bool IsDead => state == State.Dead;
    private bool IsHurt => state == State.Hurt;
    private bool IsAttacking => state == State.Attacking;

    public bool IsInvulnerable => IsDead;
    public bool IsInPhaseTwo => isPhaseTwo;

    private void Awake()
    {
        if (movement == null) movement = GetComponent<Boss3MovementController>();
        if (missileAttack == null) missileAttack = GetComponent<Boss3MissileAttack>();
        if (runeAttack == null) runeAttack = GetComponent<Boss3RuneAttack>();
        if (health == null) health = GetComponent<HealthComponent>();
        if (solidCollider == null) solidCollider = GetComponent<Collider2D>();
        if (spriteRenderer == null) spriteRenderer = GetComponent<SpriteRenderer>();

        if (animator == null)
        {
            Transform visualRoot = transform.Find("VisualRoot");
            if (visualRoot != null)
            {
                animator = visualRoot.GetComponent<Animator>();
            }
        }

        if (freezeTintRenderer != null)
        {
            originalFreezeTintColor = freezeTintRenderer.color;
        }

        currentFreezeTintAmount = 0f;
    }

    private void OnEnable()
    {
        if (health == null) health = GetComponent<HealthComponent>();

        if (health != null)
        {
            health.HealthChanged += HandlePhaseHealthChanged;
        }
    }

    private void OnDisable()
    {
        if (health != null)
        {
            health.HealthChanged -= HandlePhaseHealthChanged;
        }
    }

    private void Start()
    {
        EnterWaitingToAttack();

        if (health != null)
        {
            lastKnownHealth = health.CurrentHealth;
            lastKnownMaxHealth = health.MaxHealth;
            TryEnterPhaseTwo(lastKnownHealth, lastKnownMaxHealth);
        }
    }

    private void Update()
    {
        if (IsDead) return;

        PollHealthForHurtThresholds();
        RefreshFreezeTintVisual();

        if (IsDead || IsHurt || IsEffectLocked) return;

        switch (state)
        {
            case State.WaitingToAttack:
                UpdateWaitingToAttack();
                break;

            case State.Attacking:
                UpdateAttacking();
                break;

            case State.Cooldown:
                UpdateCooldown();
                break;
        }
    }

    private void PollHealthForHurtThresholds()
    {
        if (health == null) return;

        int currentHealth = health.CurrentHealth;
        int maxHealth = health.MaxHealth;

        if (currentHealth != lastKnownHealth || maxHealth != lastKnownMaxHealth)
        {
            lastKnownHealth = currentHealth;
            lastKnownMaxHealth = maxHealth;

            if (currentHealth <= 0)
            {
                BeginDeath();
                return;
            }

            HandleHealthChanged(currentHealth, maxHealth);
        }
    }

    private void HandleHealthChanged(int currentHealth, int maxHealth)
    {
        if (IsDead) return;
        if (maxHealth <= 0) return;

        TryEnterPhaseTwo(currentHealth, maxHealth);

        float normalizedHealth = (float)currentHealth / maxHealth;
        bool crossedAtLeastOneThreshold = false;

        while (normalizedHealth <= nextHurtThreshold)
        {
            crossedAtLeastOneThreshold = true;
            nextHurtThreshold -= 0.1f;

            if (nextHurtThreshold <= 0f)
            {
                nextHurtThreshold = -1f;
                break;
            }
        }

        if (crossedAtLeastOneThreshold)
        {
            TryEnterHurtState();
        }
    }

    private void HandlePhaseHealthChanged(int currentHealth, int maxHealth)
    {
        TryEnterPhaseTwo(currentHealth, maxHealth);
    }

    private void TryEnterPhaseTwo(int currentHealth, int maxHealth)
    {
        if (isPhaseTwo || IsDead) return;
        if (currentHealth <= 0 || maxHealth <= 0) return;

        float normalizedHealth = (float)currentHealth / maxHealth;
        if (normalizedHealth <= phaseTwoHealthThreshold)
        {
            isPhaseTwo = true;
        }
    }

    private void CancelCombatAndLockMovement()
    {
        if (missileAttack != null)
        {
            missileAttack.CancelAttack();
        }

        if (runeAttack != null)
        {
            runeAttack.CancelAttack();
        }

        if (movement != null)
        {
            movement.SetAttackLock(true);
            movement.SetExternalEffectLock(true);
        }
    }

    private void ReleaseMovementLocksIfAllowed()
    {
        if (movement == null) return;

        movement.SetExternalEffectLock(isFrozen || isAnchored);

        if (!IsAttacking && !IsHurt)
        {
            movement.SetAttackLock(false);
        }
    }

    public void ApplyFreeze(float durationSeconds)
    {
        if (IsDead) return;

        if (freezeRoutine != null)
        {
            StopCoroutine(freezeRoutine);
        }

        freezeRoutine = StartCoroutine(FreezeRoutine(durationSeconds));
    }

    private IEnumerator FreezeRoutine(float durationSeconds)
    {
        EnterFreezeState();

        yield return new WaitForSeconds(durationSeconds);

        ExitFreezeState();
        freezeRoutine = null;
    }

    private void EnterFreezeState()
    {
        if (IsDead) return;

        isFrozen = true;

        CancelCombatAndLockMovement();
        ApplyFreezeTint();

        if (animator != null)
        {
            animator.speed = 0f;
        }
    }

    private void ExitFreezeState()
    {
        if (IsDead) return;

        isFrozen = false;
        ClearFreezeTint();

        if (animator != null)
        {
            animator.speed = 1f;
        }

        if (!IsHurt)
        {
            state = State.Cooldown;
            timer = cooldownAfterAttack;
        }

        ReleaseMovementLocksIfAllowed();
    }

    private void ApplyFreezeTint()
    {
        if (freezeTintRenderer == null) return;

        if (freezeTintRoutine != null)
        {
            StopCoroutine(freezeTintRoutine);
        }

        freezeTintRoutine = StartCoroutine(LerpFreezeTint(1f));
    }

    private void ClearFreezeTint()
    {
        if (freezeTintRenderer == null) return;

        if (freezeTintRoutine != null)
        {
            StopCoroutine(freezeTintRoutine);
        }

        freezeTintRoutine = StartCoroutine(LerpFreezeTint(0f));
    }

    private IEnumerator LerpFreezeTint(float target)
    {
       while (!Mathf.Approximately(currentFreezeTintAmount, target))
        {
            currentFreezeTintAmount = Mathf.MoveTowards(
                currentFreezeTintAmount,
                target,
                freezeTintLerpSpeed * Time.deltaTime);

            RefreshFreezeTintVisual();
            yield return null;
        }

        currentFreezeTintAmount = target;
        RefreshFreezeTintVisual();
        freezeTintRoutine = null;
    }

    private void RefreshFreezeTintVisual()
    {
        if (freezeTintRenderer == null) return;

        float blend = Mathf.Clamp01(currentFreezeTintAmount);
        Color strongerTint = Color.Lerp(originalFreezeTintColor, freezeTintColor, blend);

        float brightnessBoost = Mathf.Lerp(1f, 1.25f, blend);
        float pulse = 1f + Mathf.Sin(Time.time * 6f) * 0.04f * blend;

        freezeTintRenderer.color = strongerTint * brightnessBoost * pulse;
    }

    public void ApplyStunt(float durationSeconds)
    {
        if (IsDead) return;

        if (anchorRoutine != null)
        {
            StopCoroutine(anchorRoutine);
            anchorRoutine = null;
        }

        anchorRoutine = StartCoroutine(AnchorRoutine(durationSeconds));
    }

    private IEnumerator AnchorRoutine(float durationSeconds)
    {
        bool wasAlreadyAnchored = isAnchored;

        if (!wasAlreadyAnchored)
        {
            EnterAnchorState();
        }

        yield return new WaitForSeconds(durationSeconds);

        ExitAnchorState();
        anchorRoutine = null;
    }

    private void EnterAnchorState()
    {
        if (IsDead) return;

        isAnchored = true;

        CancelCombatAndLockMovement();

        if (animator != null)
        {
            animator.ResetTrigger("MissileAttack");
            animator.ResetTrigger("RuneAttack");
            animator.ResetTrigger(hurtTriggerName);
        }
    }

    private void ExitAnchorState()
    {
        if (IsDead) return;

        isAnchored = false;

        ReleaseMovementLocksIfAllowed();
        EnterWaitingToAttack();
    }

    private void TryEnterHurtState()
    {
        if (IsDead) return;
        if (IsHurt) return;
        if (isFrozen) return;

        if (hurtRoutine != null)
        {
            StopCoroutine(hurtRoutine);
            hurtRoutine = null;
        }

        hurtRoutine = StartCoroutine(HurtRoutine());
    }

    private IEnumerator HurtRoutine()
    {
        EnterHurtState();

        yield return new WaitForSeconds(hurtLockSeconds);

        ExitHurtState();
        hurtRoutine = null;
    }

    private void EnterHurtState()
    {
        CancelCurrentAttackIfNeeded();

        state = State.Hurt;

        if (movement != null)
        {
            movement.SetAttackLock(true);
        }

        if (missileAttack != null)
        {
            missileAttack.CancelAttack();
        }

        if (runeAttack != null)
        {
            runeAttack.CancelAttack();
        }

        if (animator != null)
        {
            animator.ResetTrigger("MissileAttack");
            animator.ResetTrigger("RuneAttack");
            animator.ResetTrigger(hurtTriggerName);
            animator.SetTrigger(hurtTriggerName);
        }
    }

    private void ExitHurtState()
    {
        if (IsDead) return;
        if (!IsHurt) return;

        ReleaseMovementLocksIfAllowed();
        EnterWaitingToAttack();
    }

    private void CancelCurrentAttackIfNeeded()
    {
        if (!IsAttacking) return;

        if (missileAttack != null)
        {
            missileAttack.CancelAttack();
        }

        if (runeAttack != null)
        {
            runeAttack.CancelAttack();
        }

        if (movement != null)
        {
            movement.SetAttackLock(false);
        }
    }

   public void BeginDeath()
    {
        if (isDead) return;

        isDead = true;
        state = State.Dead;

        StopAllCoroutines();

        if (hurtRoutine != null)
        {
            StopCoroutine(hurtRoutine);
            hurtRoutine = null;
        }

        if (freezeRoutine != null)
        {
            StopCoroutine(freezeRoutine);
            freezeRoutine = null;
        }

        if (freezeTintRoutine != null)
        {
            StopCoroutine(freezeTintRoutine);
            freezeTintRoutine = null;
        }

        if (anchorRoutine != null)
        {
            StopCoroutine(anchorRoutine);
            anchorRoutine = null;
        }

        CleanupActiveAttacksAndEffects();
        DisableCombatInteraction();

        if (movement != null)
        {
            movement.HandleDeath();
            movement.SetAttackLock(true);
            movement.SetExternalEffectLock(true);
        }

        if (animator != null)
        {
            animator.speed = 1f;
            animator.ResetTrigger("MissileAttack");
            animator.ResetTrigger("RuneAttack");
            animator.ResetTrigger(hurtTriggerName);
            animator.SetTrigger("Die");
        }
    }

    private void CleanupActiveAttacksAndEffects()
    {
        if (missileAttack != null)
        {
            missileAttack.CancelAttack();
        }

        if (runeAttack != null)
        {
            runeAttack.CancelAttack();
        }

        if (movement != null)
        {
            movement.StopAllTeleportVfx();
        }

        isFrozen = false;
        isAnchored = false;
        currentFreezeTintAmount = 0f;

        if (freezeTintRenderer != null)
        {
            freezeTintRenderer.color = originalFreezeTintColor;
        }
    }

    private void DisableCombatInteraction()
    {
        if (solidCollider != null)
        {
            solidCollider.enabled = false;
        }

        var rb = GetComponent<Rigidbody2D>();
        if (rb != null)
        {
            rb.linearVelocity = Vector2.zero;
            rb.angularVelocity = 0f;
            rb.simulated = false;
        }

        var damageReceiver = GetComponent<GenericDamageReceiver>();
        if (damageReceiver != null)
        {
            damageReceiver.enabled = false;
        }
    }

    private void UpdateWaitingToAttack()
    {
        if (movement != null && !movement.CanStartAttack())
        {
            return;
        }

        timer -= Time.deltaTime;

        if (timer <= 0f)
        {
            StartAttack();
        }
    }

    private void UpdateAttacking()
    {
        timer -= Time.deltaTime;

        if (timer <= 0f)
        {
            EndAttack();
        }
    }

    private void UpdateCooldown()
    {
        timer -= Time.deltaTime;

        if (timer <= 0f)
        {
            EnterWaitingToAttack();
        }
    }

    private void EnterWaitingToAttack()
    {
        state = State.WaitingToAttack;
        currentAttackType = default;
        timer = timeBeforeAttack;

        if (movement != null)
        {
            movement.SetAttackLock(false);
        }
    }

    private void StartAttack()
    {
        state = State.Attacking;

        if (movement != null)
        {
            movement.SetAttackLock(true);
        }

        currentAttackType = ChooseAttackType();

        if (missileAttack != null)
        {
            missileAttack.BeginAttack();
        }

        if (runeAttack != null)
        {
            runeAttack.BeginAttack();
        }

        switch (currentAttackType)
        {
            case AttackType.Missile:
                timer = missileAttackDuration;

                if (animator != null)
                {
                    animator.SetTrigger("MissileAttack");
                }
                break;

            case AttackType.Rune:
                timer = runeAttackDuration;

                if (animator != null)
                {
                    animator.SetTrigger("RuneAttack");
                }
                break;
        }
    }

    private void EndAttack()
    {
        if (movement != null)
        {
            movement.SetAttackLock(false);
        }

        state = State.Cooldown;
        timer = cooldownAfterAttack;
    }

    private AttackType ChooseAttackType()
    {
        if (runeAttack == null)
        {
            return AttackType.Missile;
        }

        return Random.value < runeAttackChance
            ? AttackType.Rune
            : AttackType.Missile;
    }

    public void AE_FireMissile()
    {
        if (!IsAttacking) return;
        if (currentAttackType != AttackType.Missile) return;

        if (missileAttack != null)
        {
            missileAttack.Fire();
        }
        else
        {
            Debug.LogWarning("Boss3Controller: missileAttack reference is null.", this);
        }
    }

    public void AE_CastRunes()
    {
        if (!IsAttacking) return;
        if (currentAttackType != AttackType.Rune) return;

        if (runeAttack != null)
        {
            StartCoroutine(runeAttack.Execute(isPhaseTwo));
        }
        else
        {
            Debug.LogWarning("Boss3Controller: runeAttack reference is null.", this);
        }
    }

    public void AE_DeathFinished()
    {
        Vector3 spawnPosition = remainsSpawnPoint != null
            ? remainsSpawnPoint.position
            : transform.position;

        if (remainsPrefab != null && deathRemainsSprite != null)
        {
            BossRemains remains = Instantiate(remainsPrefab, spawnPosition, Quaternion.identity);
            remains.Init(deathRemainsSprite);
        }

        if (animator != null)
        {
            animator.gameObject.SetActive(false);
        }
    }
}
