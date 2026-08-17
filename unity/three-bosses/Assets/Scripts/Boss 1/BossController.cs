using System.Collections;
using UnityEngine;

[RequireComponent(typeof(HealthComponent), typeof(BossMover))]
public sealed class BossController : MonoBehaviour, IBossEffectReceiver
{
    private enum BossState { Idle, Attacking, Hurt, Dying }

    [SerializeField] private SpriteRenderer visualRenderer;

    [Header("Refs")]
    [SerializeField] private BossMover mover;
    [SerializeField] private BossShooter shooter;
    [SerializeField] private SpriteRenderer sprite;
    [SerializeField] private Animator animator;

    [Header("Attack")]
    [SerializeField, Min(0.1f)] private float attackInterval = 2.5f;
    [SerializeField, Min(1)] private int phase1ShotsPerAttack = 2;
    [SerializeField, Min(1)] private int phase2ShotsPerAttack = 4;

    private int ShotsPerAttack => phase2Started ? phase2ShotsPerAttack : phase1ShotsPerAttack;
    public int CurrentShotsPerAttack => ShotsPerAttack;

    [Header("Freeze VFX")]
    [SerializeField] private Color freezeTint = new Color(0.529f, 0.808f, 0.980f, 1f); // light-blue-ish
    [SerializeField, Min(0f)] private float freezePulseSpeed = 6f;
    [SerializeField, Range(0f, 1f)] private float freezeTintStrength = 0.6f;

    private float freezeUntil = -1f;
    private Color baseColor;

    private float stuntUntil = -1f;
    private bool stuntActive;

    [Header("Phase 2")]
    [SerializeField, Range(0.1f, 0.9f)] private float phase2Threshold = 0.5f;
    [SerializeField, Min(0.1f)] private float phaseTransitionSeconds = 2.0f;

    [Header("Death")]
    [SerializeField] private BossRemains remainsPrefab;
    [SerializeField] private Sprite deathRemainsSprite; // last frame sprite
    [SerializeField] private Collider2D bodyCollider;
    [SerializeField] private BossDamageReceiver damageReceiver; // BossDamageReceiver
    [SerializeField] private GameObject visualRoot; // usually Boss/Visual

    private static readonly int AnimDie = Animator.StringToHash("Die");

    public bool IsInvulnerable =>
        isTransitioning || state == BossState.Dying || health.IsDead;

    private bool phase2Started;
    private bool isTransitioning;

    private static readonly int AnimTransition = Animator.StringToHash("Transition");

    private HealthComponent health;
    private BossState state;

    private Coroutine attackLoop;

    private int lastHealth;
    private float nextHurtThreshold = 0.9f;
    private const float HurtStep = 0.1f;

    private static readonly int AnimAttack = Animator.StringToHash("Attack");
    private static readonly int AnimHurt = Animator.StringToHash("Hurt");

    private bool IsMovementLocked()
    {
        return IsFrozenNow()
            || stuntActive
            || isTransitioning
            || state == BossState.Hurt
            || state == BossState.Dying
            || health.IsDead;
    }

    private bool IsAttackLocked()
    {
        return IsFrozenNow()
            || isTransitioning
            || state == BossState.Hurt
            || state == BossState.Dying
            || health.IsDead;
    }

    private bool IsAnimatorLocked()
    {
        return IsFrozenNow();
    }

    private void Awake()
    {
        health = GetComponent<HealthComponent>();
        if (mover == null) mover = GetComponent<BossMover>();
        if (shooter == null) shooter = GetComponent<BossShooter>();
        if (animator == null) animator = GetComponentInChildren<Animator>();
        if (visualRenderer == null) visualRenderer = GetComponentInChildren<SpriteRenderer>();
        if (bodyCollider == null) bodyCollider = GetComponent<Collider2D>();
        if (damageReceiver == null) damageReceiver = GetComponent<BossDamageReceiver>();
        if (visualRoot == null && animator != null) visualRoot = animator.gameObject;
        if (visualRenderer != null) baseColor = visualRenderer.color;

        state = BossState.Idle;
    }

    private void Update()
    {
        // timers
        if (stuntActive && Time.time >= stuntUntil)
            ExitStunt();

        // freeze visuals + freeze end
        if (IsFrozenNow())
        {
            ApplyFreezeVisuals();
            ApplyPauseState();
            return;
        }
        else
        {
            // if we just ended freeze this frame
            if (freezeUntil >= 0f && Time.time >= freezeUntil && visualRenderer != null && visualRenderer.color != baseColor)
                ExitFreeze();
        }

        ApplyPauseState();
    }

    private void ApplyPauseState()
    {
        bool movePaused = IsMovementLocked();
        mover?.SetPaused(movePaused);

        bool attackPaused = IsAttackLocked();
        shooter?.SetPaused(attackPaused);

        if (animator != null)
        {
            animator.speed = IsAnimatorLocked() ? 0f : 1f;
        }
    }

    public void ApplyStunt(float seconds)
    {
        if (seconds <= 0f) return;

        float until = Time.time + seconds;
        bool wasStunting = Time.time < stuntUntil;

        stuntUntil = Mathf.Max(stuntUntil, until);

        if (!wasStunting)
            EnterStunt();
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

    private void SetMovementPaused(bool paused) => mover?.SetPaused(paused);
    private void SetAttacksPaused(bool paused) => shooter?.SetPaused(paused);

    private void LateUpdate()
    {
        if (IsFrozenNow()) return;
    }

    public void ApplyFreeze(float seconds)
    {
        if (seconds <= 0f) return;

        float until = Time.time + seconds;
        bool wasFrozen = IsFrozenNow();

        freezeUntil = Mathf.Max(freezeUntil, until);

        if (!wasFrozen)
            EnterFreeze();
    }

    private bool IsFrozenNow() => Time.time < freezeUntil;

    private void EnterFreeze()
    {
        ApplyPauseState();

        if (visualRenderer != null)
            visualRenderer.color = baseColor;
    }

    private void ExitFreeze()
    {
        ClearFreezeVisuals();
        ApplyPauseState();
    }

    private void ApplyFreezeVisuals()
    {
        if (visualRenderer == null) return;

        float t = (Mathf.Sin(Time.time * freezePulseSpeed) + 1f) * 0.5f;
        float strength = Mathf.Lerp(0.35f, 1f, t) * freezeTintStrength;
        visualRenderer.color = Color.Lerp(baseColor, freezeTint, strength);
    }

    private void ClearFreezeVisuals()
    {
        if (visualRenderer == null) return;
        visualRenderer.color = baseColor;
    }

    private void OnEnable()
    {
        lastHealth = health.CurrentHealth;

        nextHurtThreshold = 0.9f;

        // subscribe after seeding
        health.HealthChanged += OnHealthChanged;
        health.Died += OnDied;

        mover?.StartPattern();
        mover?.SetSpeedMultiplier(1f);
        mover?.SetDwellMultiplier(1f);

        if (attackLoop == null) attackLoop = StartCoroutine(AttackLoop());
    }

    private void OnDisable()
    {
        if (health != null)
        {
            health.HealthChanged -= OnHealthChanged;
            health.Died -= OnDied;
        }

        if (attackLoop != null) StopCoroutine(attackLoop);
        attackLoop = null;

        mover?.StopPattern();
    }

    private IEnumerator AttackLoop()
    {
        yield return new WaitForSeconds(0.5f);

        while (true)
        {
            if (!IsAttackLocked() && (state == BossState.Idle || state == BossState.Attacking))
            {
                TriggerAttack();
                yield return new WaitForSeconds(attackInterval);
            }
            else
            {
                yield return null;
            }
        }
    }

    private void TriggerAttack()
    {
        if (IsAttackLocked()) return;

        state = BossState.Attacking;
        animator.SetTrigger(AnimAttack);
    }

    private void OnHealthChanged(int current, int max)
    {
        if (health.IsDead || isTransitioning)
        {
            lastHealth = current;
            return;
        }

        float prevRatio = max > 0 ? (float)lastHealth / max : 1f;
        float newRatio  = max > 0 ? (float)current / max : 0f;

        lastHealth = current;

        if (newRatio >= prevRatio) return; // only damage

        if (newRatio <= nextHurtThreshold)
        {
            TriggerHurt();
            nextHurtThreshold -= HurtStep;
        }

        if (!phase2Started && newRatio <= phase2Threshold)
            StartCoroutine(PhaseTransitionRoutine());
    }

    private void TriggerHurt()
    {
        if (state == BossState.Dying || isTransitioning) return;

        state = BossState.Hurt;

        SetMovementPaused(true);
        SetAttacksPaused(true);

        if (attackLoop != null)
        {
            StopCoroutine(attackLoop);
            attackLoop = null;
        }

        animator.ResetTrigger(AnimAttack);
        animator.SetTrigger(AnimHurt);
    }

    public void OnHurtAnimComplete()
    {
        if (state != BossState.Hurt) return;
        if (state == BossState.Dying) return;

        SetAttacksPaused(false);
        SetMovementPaused(false);
        state = BossState.Idle;

        // Make sure we resume attacks if they were paused by hurt logic
        if (attackLoop == null && !health.IsDead && !isTransitioning)
            attackLoop = StartCoroutine(AttackLoop());
    }

    public void OnAttackAnimComplete()
    {
        if (state == BossState.Attacking)
            state = BossState.Idle;
    }

    public void OnDeathAnimComplete()
    {
        // Spawn remains that fall
        if (remainsPrefab != null && deathRemainsSprite != null)
        {
            var r = Instantiate(remainsPrefab, transform.position, Quaternion.identity);
            r.Init(deathRemainsSprite);
        }

        // Hide boss visuals so only remains are visible
        if (visualRoot != null) visualRoot.SetActive(false);

        // Destroy boss root (remains is separate)
        Destroy(gameObject);
    }

    private void OnDied()
    {
        if (state == BossState.Dying) return;

        state = BossState.Dying;

        if (attackLoop != null) StopCoroutine(attackLoop);
        attackLoop = null;

        mover?.StopPattern();
        mover?.SetPaused(true);

        if (damageReceiver != null) damageReceiver.enabled = false;
        if (bodyCollider != null) bodyCollider.enabled = false;

        animator.ResetTrigger(AnimAttack);
        animator.ResetTrigger(AnimHurt);
        animator.ResetTrigger(AnimTransition);

        animator.SetTrigger(AnimDie);
    }

    private IEnumerator PhaseTransitionRoutine()
    {
        phase2Started = true;
        isTransitioning = true;

        state = BossState.Idle;

        if (damageReceiver != null) damageReceiver.enabled = false;

        SetAttacksPaused(true);
        SetMovementPaused(true);

        if (attackLoop != null)
        {
            StopCoroutine(attackLoop);
            attackLoop = null;
        }

        animator.ResetTrigger(AnimAttack);
        animator.ResetTrigger(AnimHurt);
        animator.SetTrigger(AnimTransition);

        float t = 0f;
        while (t < phaseTransitionSeconds)
        {
            if (visualRenderer != null)
            {
                float pulse = Mathf.Abs(Mathf.Sin(t * 12f));
                visualRenderer.color = Color.Lerp(Color.white, Color.red, pulse);
            }

            t += Time.deltaTime;
            yield return null;
        }

        if (visualRenderer != null)
            visualRenderer.color = Color.white;

        state = BossState.Idle;
        isTransitioning = false;

        if (damageReceiver != null) damageReceiver.enabled = true;

        SetAttacksPaused(false);
        SetMovementPaused(false);

        animator.Play("Idle", 0, 0f);

        mover?.SetSpeedMultiplier(1.5f);
        mover?.SetDwellMultiplier(0.4f);

        if (attackLoop == null && !health.IsDead)
            attackLoop = StartCoroutine(AttackLoop());
    }
}
