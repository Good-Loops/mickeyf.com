using System;
using System.Collections;
using UnityEngine;

public sealed class Boss2Mover : MonoBehaviour
{
    private enum MovementState
    {
        Patrolling,
        WaitingToTeleport,
        TeleportingOut,
        TeleportingIn
    }

    [Serializable]
    public sealed class PlatformLane
    {
        public Transform anchor;
        public Transform leftLimit;
        public Transform rightLimit;

        public bool IsValid()
        {
            return anchor != null && leftLimit != null && rightLimit != null;
        }
    }

    [Header("Platform Lanes")]
    [SerializeField] private PlatformLane[] platforms;

    [Header("Movement")]
    [SerializeField, Min(0.1f)] private float moveSpeed = 3f;
    [SerializeField, Min(0.05f)] private float edgeTolerance = 0.05f;

    [Header("Phase 2")]
    [SerializeField, Min(1f)] private float phase2SpeedMultiplier = 1.4f;

    private float baseMoveSpeed;

    [Header("Timing")]
    [SerializeField, Min(0f)] private float patrolDuration = 2.5f;
    [SerializeField, Min(0f)] private float waitBeforeTeleport = 0.5f;
    [SerializeField, Min(0f)] private float teleportOutDuration = 0.15f;
    [SerializeField, Min(0f)] private float teleportInDuration = 0.15f;

    [Header("References")]
    [SerializeField] private SpriteRenderer spriteRenderer;
    [SerializeField] private Animator animator;

    [Header("Startup")]
    [SerializeField, Min(0)] private int startingPlatformIndex = 0;
    [SerializeField] private bool startMovingRight = true;

    private MovementState state;
    private int currentPlatformIndex;
    private int moveDirection = 1; // 1 = right, -1 = left
    private float patrolTimer;
    private bool isPaused;

    private static readonly int IsMovingHash = Animator.StringToHash("IsMoving");

    public int FacingDirection => moveDirection;

    public event Action OnTeleportChargeStarted;
    public event Action OnTeleportOutStarted;
    public event Action OnTeleportInStarted;
    public event Action OnTeleportFinished;

    private void Awake()
    {
        baseMoveSpeed = moveSpeed;

        ValidateReferences();

        if (!HasValidPlatforms())
        {
            Debug.LogError("[Boss2MovementController] No valid platforms configured.", this);
            enabled = false;
            return;
        }

        currentPlatformIndex = Mathf.Clamp(startingPlatformIndex, 0, platforms.Length - 1);
        moveDirection = startMovingRight ? 1 : -1;

        SnapToPlatform(currentPlatformIndex);
        state = MovementState.Patrolling;
        patrolTimer = patrolDuration;

        UpdateFacing();
        UpdateAnimation();
    }

    private void Update()
    {
        if (isPaused) return;

        switch (state)
        {
            case MovementState.Patrolling:
                TickPatrol();
                break;

            case MovementState.WaitingToTeleport:
            case MovementState.TeleportingOut:
            case MovementState.TeleportingIn:
                break;
        }
    }

    private void TickPatrol()
    {
        PlatformLane lane = platforms[currentPlatformIndex];
        if (!lane.IsValid())
        {
            Debug.LogError($"[Boss2MovementController] Platform {currentPlatformIndex} is invalid.", this);
            enabled = false;
            return;
        }

        Vector3 position = transform.position;
        float nextX = position.x + (moveDirection * moveSpeed * Time.deltaTime);

        float leftX = lane.leftLimit.position.x;
        float rightX = lane.rightLimit.position.x;

        if (moveDirection < 0 && nextX <= leftX + edgeTolerance)
        {
            nextX = leftX;
            moveDirection = 1;
            UpdateFacing();
        }
        else if (moveDirection > 0 && nextX >= rightX - edgeTolerance)
        {
            nextX = rightX;
            moveDirection = -1;
            UpdateFacing();
        }

        transform.position = new Vector3(nextX, lane.anchor.position.y, position.z);

        patrolTimer -= Time.deltaTime;
        if (patrolTimer <= 0f)
        {
            StartCoroutine(TeleportRoutine());
        }
    }

    private IEnumerator TeleportRoutine()
    {
        state = MovementState.WaitingToTeleport;
        UpdateAnimation();
        OnTeleportChargeStarted?.Invoke();

        if (waitBeforeTeleport > 0f)
            yield return WaitForSecondsWhileRespectingPause(waitBeforeTeleport);

        state = MovementState.TeleportingOut;
        UpdateAnimation();
        OnTeleportOutStarted?.Invoke();

        SetVisible(false);

        if (teleportOutDuration > 0f)
            yield return WaitForSecondsWhileRespectingPause(teleportOutDuration);

        int nextPlatformIndex = ChooseNextPlatformIndex();
        currentPlatformIndex = nextPlatformIndex;
        SnapToPlatform(currentPlatformIndex);

        state = MovementState.TeleportingIn;
        UpdateAnimation();
        SetVisible(true);
        OnTeleportInStarted?.Invoke();

        if (teleportInDuration > 0f)
            yield return WaitForSecondsWhileRespectingPause(teleportInDuration);

        patrolTimer = patrolDuration;
        state = MovementState.Patrolling;
        UpdateFacing();
        UpdateAnimation();
        OnTeleportFinished?.Invoke();
    }

    private int ChooseNextPlatformIndex()
    {
        if (platforms.Length <= 1)
            return currentPlatformIndex;

        int nextIndex = currentPlatformIndex;

        for (int i = 0; i < 10; i++)
        {
            int candidate = UnityEngine.Random.Range(0, platforms.Length);
            if (candidate != currentPlatformIndex && platforms[candidate] != null && platforms[candidate].IsValid())
            {
                nextIndex = candidate;
                break;
            }
        }

        if (nextIndex == currentPlatformIndex)
        {
            for (int i = 0; i < platforms.Length; i++)
            {
                if (i != currentPlatformIndex && platforms[i] != null && platforms[i].IsValid())
                    return i;
            }
        }

        return nextIndex;
    }

    private void SnapToPlatform(int platformIndex)
    {
        PlatformLane lane = platforms[platformIndex];
        Vector3 anchorPosition = lane.anchor.position;
        transform.position = new Vector3(anchorPosition.x, anchorPosition.y, transform.position.z);
    }

    private void UpdateFacing()
    {
        if (spriteRenderer == null) return;

        // Adjust if your sprite faces the opposite direction by default.
        spriteRenderer.flipX = moveDirection < 0;
    }

    private void UpdateAnimation()
    {
        if (animator == null) return;

        bool isMoving = !isPaused && state == MovementState.Patrolling;
        animator.SetBool(IsMovingHash, isMoving);
    }

    private void SetVisible(bool visible)
    {
        if (spriteRenderer != null)
            spriteRenderer.enabled = visible;
    }

    public void SetPaused(bool paused)
    {
        isPaused = paused;
        UpdateAnimation();
    }

    public void SetPhase2(bool enabled)
    {
        moveSpeed = enabled
            ? baseMoveSpeed * phase2SpeedMultiplier
            : baseMoveSpeed;
    }

    private bool HasValidPlatforms()
    {
        if (platforms == null || platforms.Length == 0)
            return false;

        for (int i = 0; i < platforms.Length; i++)
        {
            if (platforms[i] != null && platforms[i].IsValid())
                return true;
        }

        return false;
    }

    private void ValidateReferences()
    {
        if (spriteRenderer == null)
            spriteRenderer = GetComponentInChildren<SpriteRenderer>();

        if (animator == null)
            animator = GetComponentInChildren<Animator>();
    }

    private IEnumerator WaitForSecondsWhileRespectingPause(float seconds)
    {
        float elapsed = 0f;

        while (elapsed < seconds)
        {
            if (!isPaused)
                elapsed += Time.deltaTime;

            yield return null;
        }
    }

#if UNITY_EDITOR
    private void OnDrawGizmosSelected()
    {
        if (platforms == null) return;

        Gizmos.color = Color.cyan;

        foreach (PlatformLane lane in platforms)
        {
            if (lane == null || !lane.IsValid()) continue;

            Gizmos.DrawLine(lane.leftLimit.position, lane.rightLimit.position);
            Gizmos.DrawWireSphere(lane.anchor.position, 0.15f);
            Gizmos.DrawWireSphere(lane.leftLimit.position, 0.1f);
            Gizmos.DrawWireSphere(lane.rightLimit.position, 0.1f);
        }
    }
#endif
}
