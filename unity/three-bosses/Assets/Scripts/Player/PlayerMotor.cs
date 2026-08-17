using UnityEngine;
using UnityEngine.InputSystem;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class PlayerMotor : MonoBehaviour
{
    [SerializeField] private PlayerAnimator playerAnimator;

    [Header("Health")]
    [SerializeField] private HealthComponent health;

    [Header("Movement")]
    [SerializeField] private float moveSpeed = 6f;

    [Header("Jump")]
    [SerializeField] private float jumpVelocity = 12f;
    [SerializeField] private int extraJumps = 1;          // 1 = double jump total
    [SerializeField] private float coyoteTime = 0.10f;    // seconds
    [SerializeField] private float jumpBufferTime = 0.10f;// seconds
    [SerializeField] private JumpDustVfx jumpDustVfx;

    [Header("Dash")]
    [SerializeField] private float dashSpeed = 16f;
    [SerializeField] private float dashMoveDuration = 0.18f; // physics dash time
    [SerializeField] private float dashVisualDuration = 0.24f; // visual dash time
    [SerializeField] private float dashCooldown = 0.35f;
    [SerializeField] private DashTrailVfx dashTrailVfx;

    private bool isDashingMove;
    private bool isDashVisual;

    private float dashMoveTimeLeft;
    private float dashVisualTimeLeft;

    private float dashCooldownLeft;
    private float dashDirX;

    private bool dashPressed;

    public bool IsDashingVisual => isDashVisual;

    [Header("Ground Check")]
    [SerializeField] private Transform groundCheck;
    [SerializeField] private Vector2 groundCheckSize = new(0.45f, 0.10f);
    [SerializeField] private LayerMask groundMask;
    [SerializeField] private LandDustVfx landDustVfx;

    private Rigidbody2D rb;

    private Vector2 moveInput;
    private bool jumpPressed;
    public bool IsGrounded { get; private set; }
    private bool wasGrounded;

    private float coyoteCounter;
    private float jumpBufferCounter;

    private int jumpsRemaining;

    private float facingX = 1f; // 1 = right, -1 = left
    public float FacingX => facingX;

    private float defaultGravityScale;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        jumpsRemaining = extraJumps;
        defaultGravityScale = rb.gravityScale;
    }

    private void Update()
    {
        if(health != null && health.IsDead)
            return;

        if (Mathf.Abs(moveInput.x) > 0.001f)
        {
            facingX = Mathf.Sign(moveInput.x);
        }

        IsGrounded = CheckGrounded();

        if (IsGrounded)
        {
            coyoteCounter = coyoteTime;
            jumpsRemaining = extraJumps;
        }
        else
        {
            coyoteCounter -= Time.deltaTime;
        }

        // Jump buffering
        if (jumpPressed)
        {
            jumpBufferCounter = jumpBufferTime;
            jumpPressed = false; // consume the press; buffer remains
        }
        else
        {
            jumpBufferCounter -= Time.deltaTime;
        }

        if (dashCooldownLeft > 0f)
        {
            dashCooldownLeft -= Time.deltaTime;
        }

        if(dashPressed)
        {
            dashPressed = false; // consume the press
            TryStartDash();
        }

        bool grounded = IsGrounded;

        if (grounded && !wasGrounded)
        {
            landDustVfx.Play();
        }

        wasGrounded = grounded;
    }

    private void FixedUpdate()
    {
        if (isDashVisual)
        {
            TickDash();
            return; // skip normal movement/jump while dashing
        }

        // Horizontal
        rb.linearVelocity = new Vector2(moveInput.x * moveSpeed, rb.linearVelocity.y);

        // Jump resolve (buffer + coyote + extra jumps)
        if (jumpBufferCounter > 0f)
        {
            if (coyoteCounter > 0f)
            {
                DoJump();
                coyoteCounter = 0f;
                jumpBufferCounter = 0f;
            }
            else if (!IsGrounded && jumpsRemaining > 0)
            {
                jumpsRemaining--;
                DoJump();
                jumpBufferCounter = 0f;
            }
        }
    }

    private void TryStartDash()
    {
        if (dashCooldownLeft > 0f) return;
        if (isDashVisual) return;

        StartDash();
    }

    private void StartDash()
    {
        isDashingMove = true;
        isDashVisual = true;

        dashMoveTimeLeft = dashMoveDuration;
        dashVisualTimeLeft = dashVisualDuration;

        dashCooldownLeft = dashCooldown;
        dashDirX = facingX;

        // Freeze vertical motion during dash
        rb.gravityScale = 0f;
        rb.linearVelocity = new Vector2(dashDirX * dashSpeed, 0f);

        playerAnimator.RestartDashAnimation();
        dashTrailVfx.Play();
    }

    private void TickDash()
    {
        // Countdowns
        dashVisualTimeLeft -= Time.fixedDeltaTime;

        if (isDashingMove)
        {
            dashMoveTimeLeft -= Time.fixedDeltaTime;
            rb.linearVelocity = new Vector2(dashDirX * dashSpeed, 0f);

            if (dashMoveTimeLeft <= 0f)
            {
                isDashingMove = false;

                // Restore gravity immediately after movement phase ends
                rb.gravityScale = defaultGravityScale;
            }
        }

        if (dashVisualTimeLeft <= 0f)
        {
            isDashVisual = false;
        }
    }

    private void EndDash()
    {
        isDashVisual = false;
        isDashingMove = false;
        rb.gravityScale = defaultGravityScale;
    }

    private void DoJump()
    {
        rb.linearVelocity = new Vector2(rb.linearVelocity.x, jumpVelocity);
        playerAnimator.RestartJumpAnimation();
        jumpDustVfx.Play();
    }

    private bool CheckGrounded()
    {
        if (!groundCheck) return false;
        return Physics2D.OverlapBox(groundCheck.position, groundCheckSize, 0f, groundMask) != null;
    }

    private void OnMove(InputValue value) => moveInput = value.Get<Vector2>();

    private void OnJump(InputValue value)
    {
        if (value.isPressed)
            jumpPressed = true;
    }

    private void OnDash(InputValue value)
    {
        if (value.isPressed)
            dashPressed = true;
    }

#if UNITY_EDITOR
    private void OnDrawGizmosSelected()
    {
        if (!groundCheck) return;
        Gizmos.color = Color.yellow;
        Gizmos.DrawWireCube(groundCheck.position, groundCheckSize);
    }
#endif
}
