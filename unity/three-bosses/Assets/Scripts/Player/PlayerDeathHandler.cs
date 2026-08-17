using UnityEngine;
using UnityEngine.InputSystem;

public sealed class PlayerDeathHandler : MonoBehaviour
{
    [SerializeField] private HealthComponent health;
    [SerializeField] private Rigidbody2D rb;
    [SerializeField] private CapsuleCollider2D aliveCollider;
    [SerializeField] private BoxCollider2D deadCollider;
    [SerializeField] private Animator animator;

    [Header("Disable on death")]
    [SerializeField] private PlayerMotor motor;
    [SerializeField] private PlayerWeaponController weapon;
    [SerializeField] private PlayerAnimator playerAnimatorScript; // if yours is a script
    [SerializeField] private PlayerInput playerInput;            // Input System component

    private static readonly int IsDeadHash = Animator.StringToHash("IsDead");
    private float cachedGravity;
    private RigidbodyType2D cachedBodyType;

    private void Awake()
    {
        if (deadCollider != null) deadCollider.enabled = false;

        if (rb != null)
        {
            cachedGravity = rb.gravityScale;
            cachedBodyType = rb.bodyType;
        }
    }

    private void OnEnable()
    {
        if (health != null) health.Died += OnDied;
    }

    private void OnDisable()
    {
        if (health != null) health.Died -= OnDied;
    }

    private void OnDied()
    {
        // Disable control sources
        if (playerInput != null) playerInput.enabled = false;
        if (motor != null) motor.enabled = false;
        if (weapon != null) weapon.enabled = false;
        if (playerAnimatorScript != null) playerAnimatorScript.enabled = false;

        // Keep physics ON so the body falls
        if (rb != null)
        {
            rb.simulated = true;
            rb.bodyType = RigidbodyType2D.Dynamic;

            var v = rb.linearVelocity;
            rb.linearVelocity = new Vector2(0f, v.y);

            rb.gravityScale = cachedGravity > 0f ? cachedGravity : 1f;
        }

        if (animator != null) animator.SetBool(IsDeadHash, true);

        if (aliveCollider != null) aliveCollider.enabled = false;
        if (deadCollider != null) deadCollider.enabled = true;
    }

    public void Revive()
    {
        if (health != null) health.ResetToMax();
        if (animator != null) animator.SetBool(IsDeadHash, false);

        if (rb != null)
        {
            rb.simulated = true;
            rb.bodyType = cachedBodyType;
            rb.gravityScale = cachedGravity;
        }

        if (playerInput != null) playerInput.enabled = true;
        if (motor != null) motor.enabled = true;
        if (weapon != null) weapon.enabled = true;
        if (playerAnimatorScript != null) playerAnimatorScript.enabled = true;

        if (deadCollider != null) deadCollider.enabled = false;
        if (aliveCollider != null) aliveCollider.enabled = true;
    }
}
