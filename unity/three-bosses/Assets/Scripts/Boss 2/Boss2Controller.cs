using System;
using System.Collections;
using UnityEngine;

[DisallowMultipleComponent]
[RequireComponent(typeof(Boss2Mover), typeof(HealthComponent), typeof(Boss2DeathController))]
public sealed class Boss2Controller : MonoBehaviour, IBossEffectReceiver, IInvulnerabilitySource
{

    [Header("Refs")]
    [SerializeField] private Boss2Mover mover;
    [SerializeField] private Boss2DeathController deathController;
    [SerializeField] private Animator animator;
    [SerializeField] private SpriteRenderer visualRenderer;

    [Header("Freeze VFX")]
    [SerializeField] private Color freezeTint = new Color(0.529f, 0.808f, 0.980f, 1f);
    [SerializeField, Min(0f)] private float freezePulseSpeed = 6f;
    [SerializeField, Range(0f, 1f)] private float freezeTintStrength = 0.6f;

    private float freezeUntil = -1f;
    private float stuntUntil = -1f;
    private bool stuntActive;
    private Color baseColor;

    [Header("Health")]
    [SerializeField] private HealthComponent health;

    [Header("Phase Transition")]
    [SerializeField] private Boss2PhaseTransitionVfx phaseTransitionVfx;
    [SerializeField, Range(0.1f, 0.9f)] private float phase2Threshold = 0.5f;
    [SerializeField, Min(0.1f)] private float phaseTransitionSeconds = 2f;

    private int lastHealth;
    private bool phase2Started;
    private bool isTransitioning;

    [Header("Phase Transition Flash")]
    [SerializeField] private Color phaseTransitionFlashColor = new(1f, 0.15f, 0.15f, 1f);
    [SerializeField, Min(0.01f)] private float phaseFlashInterval = 0.07f;
    [SerializeField, Range(0f, 1f)] private float phaseFlashStrength = 0.8f;
    [SerializeField, Min(0f)] private float phaseTransitionExitDelay = 0.05f;

    private Coroutine phaseFlashRoutine;
    private bool phaseFlashVisible;
    private static readonly int PhaseTransitionHash = Animator.StringToHash("PhaseTransition");
    private static readonly int ExitPhaseTransitionHash = Animator.StringToHash("ExitPhaseTransition");

    [Header("Hurt Reaction")]
    [SerializeField] private bool enableHurtReaction = true;
    [SerializeField] private float hurtPauseDuration = 0.35f;

    private float nextHurtThreshold = 0.9f;
    private bool hurtActive;
    private static readonly int HurtHash = Animator.StringToHash("Hurt");

    [Header("Ground Slam")]
    [SerializeField] private Transform slamCheckOrigin;
    [SerializeField, Min(0.1f)] private float slamRange = 2.5f;
    [SerializeField, Min(0.1f)] private float slamCooldown = 3f;
    [SerializeField] private LayerMask playerLayer;

    private bool slamActive;
    private float slamCooldownTimer;
    private static readonly int SlamHash = Animator.StringToHash("Slam");

    [Header("Slam Damage")]
    [SerializeField] private Transform slamHitPoint;
    [SerializeField, Min(0.1f)] private float slamRadius = 1.5f;
    [SerializeField] private int slamDamage = 30;

    [Header("Projectile Attack")]
    [SerializeField] private Transform firePointRight;
    [SerializeField] private Transform firePointLeft;
    [SerializeField] private Projectile projectilePrefab;
    [SerializeField] private GameObject impactPrefab;
    [SerializeField, Min(0.1f)] private float projectileSpeed = 8f;

    [Header("Ranged Attack")]
    [SerializeField, Min(0.1f)] private float attackInterval = 3.5f;

    private float attackTimer;
    private bool attackActive;
    private static readonly int AttackHash = Animator.StringToHash("Attack");

    private bool IsDead => deathController != null && deathController.IsDead;
    public bool IsInvulnerable => IsDead || isTransitioning;
    public bool IsInPhase2 => phase2Started && !isTransitioning;

    private void Awake()
    {
        if (health == null) health = GetComponent<HealthComponent>();
        if (mover == null) mover = GetComponent<Boss2Mover>();
        if (deathController == null) deathController = GetComponent<Boss2DeathController>();
        if (animator == null) animator = GetComponentInChildren<Animator>();
        if (visualRenderer == null) visualRenderer = GetComponentInChildren<SpriteRenderer>();
        if (phaseTransitionVfx == null) phaseTransitionVfx = GetComponentInChildren<Boss2PhaseTransitionVfx>();
        if (visualRenderer != null) baseColor = visualRenderer.color;
        RefreshVisualState();

        if (firePointRight == null)
        {
            Transform found = transform.Find("FirePointRight");
            if (found != null)
                firePointRight = found;
        }
        if (firePointLeft == null)
        {
            Transform found = transform.Find("FirePointLeft");
            if (found != null)
                firePointLeft = found;
        }
        if (slamCheckOrigin == null)
        {
            Transform found = transform.Find("SlamCheckOrigin");
            if (found != null)
                slamCheckOrigin = found;
        }

        attackTimer = attackInterval;
    }

    private void Update()
    {
        CancelAttackIfInvulnerable();

        if (stuntActive && Time.time >= stuntUntil)
            ExitStunt();

        if (IsFrozenNow())
        {
            ApplyFreezeVisuals();
            ApplyPauseState();
            return;
        }

        if (freezeUntil >= 0f && Time.time >= freezeUntil)
            ExitFreeze();

        if (slamCooldownTimer > 0f && !IsFrozenNow())
            slamCooldownTimer -= Time.deltaTime;

        ApplyPauseState();

        bool playerInRange = IsPlayerInSlamRange();

        if (CanStartSlam(playerInRange))
        {
            StartGroundSlam();
        }
        else if (CanStartRangedAttack(playerInRange))
        {
            attackTimer -= Time.deltaTime;

            if (attackTimer <= 0f)
                StartRangedAttack();
        }
    }

    private IEnumerator PhaseTransitionRoutine()
    {
        phase2Started = true;
        isTransitioning = true;
        hurtActive = false;

        CancelActiveCombatActions();

        if (animator != null)
            animator.SetTrigger(PhaseTransitionHash);

        ApplyPauseState();
        StartPhaseTransitionFlash();
        phaseTransitionVfx?.PlayStart();

        yield return new WaitForSeconds(phaseTransitionSeconds);

        ActivatePhase2();

        StopPhaseTransitionFlash();
        phaseTransitionVfx?.PlayStop();

        if (animator != null)
            animator.SetTrigger(ExitPhaseTransitionHash);

        if (phaseTransitionExitDelay > 0f)
            yield return new WaitForSeconds(phaseTransitionExitDelay);
        else
            yield return null;

        isTransitioning = false;
        ApplyPauseState();
    }

    private void StartPhaseTransitionFlash()
    {
        StopPhaseTransitionFlash();

        if (visualRenderer == null)
            return;

        phaseFlashRoutine = StartCoroutine(PhaseTransitionFlashRoutine());
    }

    private IEnumerator PhaseTransitionFlashRoutine()
    {
        while (true)
        {
            phaseFlashVisible = !phaseFlashVisible;
            RefreshVisualState();
            yield return new WaitForSeconds(phaseFlashInterval);
        }
    }

    private void StopPhaseTransitionFlash()
    {
        if (phaseFlashRoutine != null)
        {
            StopCoroutine(phaseFlashRoutine);
            phaseFlashRoutine = null;
        }

        phaseFlashVisible = false;
        RefreshVisualState();
    }

    private void ActivatePhase2()
    {
        // Movement speed increase
        mover?.SetPhase2(true);

        // Ranged attack frequency increase
        attackInterval *= 0.7f;
        attackTimer = Mathf.Min(attackTimer, attackInterval);

        // Slam damage increase
        slamDamage = Mathf.RoundToInt(slamDamage * 1.5f);
    }

    private void RefreshVisualState()
    {
        if (visualRenderer == null)
            return;

        if (isTransitioning)
        {
            if (phaseFlashVisible)
            {
                visualRenderer.color = Color.Lerp(baseColor, phaseTransitionFlashColor, phaseFlashStrength);
            }
            else
            {
                visualRenderer.color = baseColor;
            }

            return;
        }

        if (IsFrozenNow())
        {
            float t = (Mathf.Sin(Time.time * freezePulseSpeed) + 1f) * 0.5f;
            float strength = Mathf.Lerp(0.35f, 1f, t) * freezeTintStrength;
            visualRenderer.color = Color.Lerp(baseColor, freezeTint, strength);
            return;
        }

        visualRenderer.color = baseColor;
    }

    private void CancelActiveCombatActions()
    {
        SetAttackActive(false);
        SetSlamActive(false);
    }

    private void OnEnable()
    {
        if (health == null)
            health = GetComponent<HealthComponent>();

        if (health != null)
        {
            lastHealth = health.CurrentHealth;
            ResetHurtThreshold();
            health.HealthChanged += OnHealthChanged;
        }
    }

    private void OnDisable()
    {
        if (health != null)
            health.HealthChanged -= OnHealthChanged;
    }

    private void OnHealthChanged(int current, int max)
    {
        if (health == null || health.IsDead || isTransitioning)
        {
            lastHealth = current;
            return;
        }

        float previousRatio = max > 0 ? (float)lastHealth / max : 1f;
        float currentRatio = max > 0 ? (float)current / max : 0f;

        lastHealth = current;

        if (currentRatio >= previousRatio)
            return;

        if (!phase2Started && currentRatio <= phase2Threshold)
            StartCoroutine(PhaseTransitionRoutine());

        if (!enableHurtReaction)
            return;

        bool crossedHurtThreshold = false;

        while (nextHurtThreshold > 0f && currentRatio <= nextHurtThreshold)
        {
            crossedHurtThreshold = true;
            nextHurtThreshold -= 0.1f;
        }

        nextHurtThreshold = Mathf.Max(0f, nextHurtThreshold);

        if (crossedHurtThreshold && CanPlayHurtReaction())
            StartCoroutine(HurtReactionRoutine());
    }

    private void StartRangedAttack()
    {
        SetAttackActive(true);

        if (animator != null)
            animator.SetTrigger(AttackHash);
    }

    private void StartGroundSlam()
    {
        SetSlamActive(true);

        if (animator != null)
            animator.SetTrigger(SlamHash);
    }

    public void EndGroundSlam()
    {
        if (!slamActive)
            return;

        SetSlamActive(false);
        slamCooldownTimer = slamCooldown;
    }

    public void PerformGroundSlamHit()
    {
        if (slamHitPoint == null)
            return;

        Collider2D[] hits = Physics2D.OverlapCircleAll(
            slamHitPoint.position,
            slamRadius,
            playerLayer
        );

        foreach (var hit in hits)
        {
            DamageUtils2D.TryDealDamage(hit, slamDamage, gameObject);
        }
    }

    public void FireProjectile()
    {
        if (IsInvulnerable) return;
        if (projectilePrefab == null) return;

        bool facingLeft = mover != null && mover.FacingDirection < 0;

        Vector2 direction = facingLeft ? Vector2.left : Vector2.right;
        Transform spawnPoint = facingLeft ? firePointLeft : firePointRight;

        if (spawnPoint == null) return;

        Projectile projectileInstance = Instantiate(
            projectilePrefab,
            spawnPoint.position,
            Quaternion.identity);

        projectileInstance.Init(direction, projectileSpeed, impactPrefab);
    }

    public void EndAttack()
    {
        if (!attackActive)
            return;

        SetAttackActive(false);
        attackTimer = attackInterval;
    }

    private void CancelAttackIfInvulnerable()
    {
        if (!IsInvulnerable)
            return;

        if (attackActive)
            SetAttackActive(false);

        if (slamActive)
            SetSlamActive(false);
    }

    private bool IsPlayerInSlamRange()
    {
        if (slamCheckOrigin == null)
            return false;

        Collider2D hit = Physics2D.OverlapCircle(
            slamCheckOrigin.position,
            slamRange,
            playerLayer
        );

        return hit != null;
    }

    public void ApplyFreeze(float seconds)
    {
        if (seconds <= 0f || IsInvulnerable) return;

        float until = Time.time + seconds;
        bool wasFrozen = IsFrozenNow();

        freezeUntil = Mathf.Max(freezeUntil, until);

        if (!wasFrozen)
            EnterFreeze();
    }

    public void ApplyStunt(float seconds)
    {
        if (seconds <= 0f || IsInvulnerable) return;

        float until = Time.time + seconds;
        bool wasStunting = Time.time < stuntUntil;

        stuntUntil = Mathf.Max(stuntUntil, until);

        if (!wasStunting)
            EnterStunt();
    }

    private void EnterFreeze()
    {
        ApplyPauseState();
        RefreshVisualState();
    }

    private void ExitFreeze()
    {
        ClearFreezeVisuals();
        ApplyPauseState();
    }

    private void EnterStunt()
    {
        stuntActive = true;
        ApplyPauseState();
    }

    private void ExitStunt()
    {
        stuntActive = false;
        ApplyPauseState();
    }

    private bool IsFrozenNow() => Time.time < freezeUntil;

    private void ApplyPauseState()
    {
        bool pauseMovement = IsFrozenNow() || stuntActive || attackActive || slamActive || hurtActive || IsInvulnerable;
        mover?.SetPaused(pauseMovement);

        if (animator != null)
        {
            bool pauseAnimator = IsFrozenNow() || isTransitioning;
            animator.speed = pauseAnimator ? 0f : 1f;
        }
    }

    private void ApplyFreezeVisuals()
    {
        RefreshVisualState();
    }

    private void ClearFreezeVisuals()
    {
        RefreshVisualState();
    }

    private void SetAttackActive(bool active)
    {
        attackActive = active;
        ApplyPauseState();
    }

    private void SetSlamActive(bool active)
    {
        slamActive = active;
        ApplyPauseState();
    }

    private void SetHurtActive(bool active)
    {
        hurtActive = active;
        ApplyPauseState();
    }

    private IEnumerator HurtReactionRoutine()
    {
        if (hurtActive)
            yield break;

        SetHurtActive(true);

        if (animator != null)
            animator.SetTrigger(HurtHash);

        yield return new WaitForSeconds(hurtPauseDuration);

        SetHurtActive(false);
    }

    private bool CanPlayHurtReaction()
    {
        return enableHurtReaction
            && !hurtActive
            && !isTransitioning
            && health != null
            && !health.IsDead;
    }

    private void ResetHurtThreshold()
    {
        nextHurtThreshold = 0.9f;
    }

    private bool CanStartSlam(bool playerInRange)
    {
        return !IsFrozenNow()
            && !stuntActive
            && !IsInvulnerable
            && !attackActive
            && !slamActive
            && !hurtActive
            && slamCooldownTimer <= 0f
            && playerInRange;
    }

    private bool CanStartRangedAttack(bool playerInRange)
    {
        return !IsFrozenNow()
            && !stuntActive
            && !IsInvulnerable
            && !attackActive
            && !slamActive
            && !hurtActive
            && !playerInRange;
    }

#if UNITY_EDITOR
    private void OnDrawGizmosSelected()
    {
        if (slamCheckOrigin != null)
        {
            Gizmos.color = Color.yellow;
            Gizmos.DrawWireSphere(slamCheckOrigin.position, slamRange);
        }

        if (slamHitPoint != null)
        {
            Gizmos.color = Color.red;
            Gizmos.DrawWireSphere(slamHitPoint.position, slamRadius);
        }
    }
#endif
}
