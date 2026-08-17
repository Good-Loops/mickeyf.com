using UnityEngine;
using UnityEngine.InputSystem;

public sealed class Boss3MovementController : MonoBehaviour
{
    private enum MovementState
    {
        Idle,
        TeleportingOut,
        TeleportingIn,
        Dead
    }

    [Header("References")]
    [SerializeField] private Transform orbitRoot;
    [SerializeField] private Transform visualRoot;
    [SerializeField] private Animator animator;
    [SerializeField] private SpriteRenderer spriteRenderer;

    [Header("Anchors")]
    [SerializeField] private Transform[] anchors;

    [Header("Hover")]
    [SerializeField] private float hoverAmplitude = 0.12f;
    [SerializeField] private float hoverFrequency = 2f;

    [Header("Orbit")]
    [SerializeField] private float orbitXAmplitude = 0.35f;
    [SerializeField] private float orbitYAmplitude = 0.12f;
    [SerializeField] private float orbitFrequency = 1.2f;

    [Header("Teleport Timing")]
    [SerializeField] private float idleDuration = 1.5f;
    [SerializeField] private float teleportOutDuration = 0.3f;
    [SerializeField] private float teleportInDuration = 0.3f;

    [Header("Teleport VFX")]
    [SerializeField] private ParticleSystem teleportOutEffectPrefab;
    [SerializeField] private ParticleSystem teleportInEffectPrefab;

    private ParticleSystem activeTeleportOutEffect;
    private ParticleSystem activeTeleportInEffect;

    private MovementState state = MovementState.Idle;

    private Transform currentAnchor;
    private Transform nextAnchor;

    private float stateTimer;
    private float hoverTime;
    private Vector3 visualBaseLocalPosition;

    private float orbitTime;
    private Vector3 orbitBaseLocalPosition;

    private bool isAttackLocked;
    private bool externalEffectLock;

    private void Awake()
    {
        if (orbitRoot != null)
        {
            orbitBaseLocalPosition = orbitRoot.localPosition;
        }

        if (visualRoot != null)
        {
            visualBaseLocalPosition = visualRoot.localPosition;
        }
    }

    private void Start()
    {
        if (anchors == null || anchors.Length == 0)
        {
            Debug.LogError("Boss3MovementController requires at least one anchor.", this);
            enabled = false;
            return;
        }

        currentAnchor = anchors[0];
        transform.position = currentAnchor.position;

        EnterIdle();
    }

    private void Update()
    {
        if (externalEffectLock) return;

        switch (state)
        {
            case MovementState.Idle:
                UpdateIdle();
                break;

            case MovementState.TeleportingOut:
                UpdateTeleportingOut();
                break;

            case MovementState.TeleportingIn:
                UpdateTeleportingIn();
                break;
        }

        UpdateOrbit();
        UpdateHover();
    }

    public void SetAttackLock(bool isLocked)
    {
        bool wasLocked = isAttackLocked;
        isAttackLocked = isLocked;

        if (wasLocked && !isAttackLocked && state == MovementState.Idle)
        {
            stateTimer = idleDuration;
        }
    }

    public void SetExternalEffectLock(bool locked)
    {
        externalEffectLock = locked;

        if (orbitRoot != null)
        {
            orbitRoot.localPosition = orbitBaseLocalPosition;
        }

        if (visualRoot != null)
        {
            visualRoot.localPosition = visualBaseLocalPosition;
        }
    }

    public bool IsIdle()
    {
        return state == MovementState.Idle;
    }

    public bool IsAttackLocked()
    {
        return isAttackLocked;
    }

    public bool CanStartAttack()
    {
        return state == MovementState.Idle && !isAttackLocked;
    }

    private void UpdateIdle()
    {
        if(isAttackLocked)
        {
            return;
        }

        stateTimer -= Time.deltaTime;

        if (stateTimer <= 0f)
        {
            StartTeleportOut();
        }
    }

    private void UpdateTeleportingOut()
    {
        stateTimer -= Time.deltaTime;

        if (stateTimer <= 0f)
        {
            CompleteTeleportOut();
        }
    }

    private void UpdateTeleportingIn()
    {
        stateTimer -= Time.deltaTime;

        if (stateTimer <= 0f)
        {
            CompleteTeleportIn();
        }
    }

    private void UpdateOrbit()
    {
        if (orbitRoot == null)
        {
            return;
        }

        if (state == MovementState.Dead)
        {
            orbitRoot.localPosition = orbitBaseLocalPosition;
            return;
        }

        if (state == MovementState.TeleportingOut)
        {
            return;
        }

        if (state == MovementState.TeleportingIn)
        {
            orbitRoot.localPosition = orbitBaseLocalPosition;
            return;
        }

        orbitTime += Time.deltaTime;

        float xOffset = Mathf.Sin(orbitTime * orbitFrequency) * orbitXAmplitude;
        float yOffset = Mathf.Cos(orbitTime * orbitFrequency) * orbitYAmplitude;

        orbitRoot.localPosition = orbitBaseLocalPosition + new Vector3(xOffset, yOffset, 0f);
    }

    private void EnterIdle()
    {
        state = MovementState.Idle;
        stateTimer = idleDuration;

        if (spriteRenderer != null)
        {
            spriteRenderer.enabled = true;
        }
    }

    private void StartTeleportOut()
    {
        state = MovementState.TeleportingOut;
        stateTimer = teleportOutDuration;

        nextAnchor = ChooseNextAnchor();
    }

    private void CompleteTeleportOut()
    {
        activeTeleportOutEffect = SpawnEffect(teleportOutEffectPrefab, GetVisibleWorldPosition());

        if (spriteRenderer != null)
        {
            spriteRenderer.enabled = false;
        }

        if (orbitRoot != null)
        {
            orbitRoot.localPosition = orbitBaseLocalPosition;
        }

        if (visualRoot != null)
        {
            visualRoot.localPosition = visualBaseLocalPosition;
        }

        currentAnchor = nextAnchor;
        transform.position = currentAnchor.position;

        state = MovementState.TeleportingIn;
        stateTimer = teleportInDuration;
    }

    private void CompleteTeleportIn()
    {
        if (spriteRenderer != null)
        {
            spriteRenderer.enabled = true;
        }

        activeTeleportInEffect = SpawnEffect(teleportInEffectPrefab, GetVisibleWorldPosition());

        EnterIdle();
    }

    public void StopAllTeleportVfx()
    {
        StopAndDestroyEffect(ref activeTeleportOutEffect);
        StopAndDestroyEffect(ref activeTeleportInEffect);
    }

    private void StopAndDestroyEffect(ref ParticleSystem effectInstance)
    {
        if (effectInstance == null)
        {
            return;
        }

        effectInstance.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
        effectInstance.Clear(true);
        Destroy(effectInstance.gameObject);
        effectInstance = null;
    }

    private Transform ChooseNextAnchor()
    {
        if (anchors.Length == 1)
        {
            return anchors[0];
        }

        Transform chosen = currentAnchor;

        while (chosen == currentAnchor)
        {
            int index = Random.Range(0, anchors.Length);
            chosen = anchors[index];
        }

        return chosen;
    }

    private void UpdateHover()
    {
        if (visualRoot == null)
        {
            return;
        }

        if (state == MovementState.Dead)
        {
            visualRoot.localPosition = visualBaseLocalPosition;
            return;
        }

        if (state == MovementState.TeleportingOut)
        {
            return;
        }

        if (state == MovementState.TeleportingIn)
        {
            visualRoot.localPosition = visualBaseLocalPosition;
            return;
        }

        hoverTime += Time.deltaTime;
        float yOffset = Mathf.Sin(hoverTime * hoverFrequency) * hoverAmplitude;

        visualRoot.localPosition = visualBaseLocalPosition + new Vector3(0f, yOffset, 0f);
    }

    private ParticleSystem SpawnEffect(ParticleSystem effectPrefab, Vector3 worldPosition)
    {
        if (effectPrefab == null)
        {
            return null;
        }

        return Instantiate(effectPrefab, worldPosition, Quaternion.identity);
    }

    private Vector3 GetVisibleWorldPosition()
    {
        if (visualRoot != null)
        {
            return visualRoot.position;
        }

        if (orbitRoot != null)
        {
            return orbitRoot.position;
        }

        return transform.position;
    }

    public void HandleDeath()
    {
        state = MovementState.Dead;

        if (orbitRoot != null)
        {
            orbitRoot.localPosition = orbitBaseLocalPosition;
        }

        if (visualRoot != null)
        {
            visualRoot.localPosition = visualBaseLocalPosition;
        }
    }
}
