using UnityEngine;

public sealed class PlayerAnimator : MonoBehaviour
{
    [SerializeField] private Animator animator;
    [SerializeField] private PlayerMotor motor;
    [SerializeField] private SpriteRenderer spriteRenderer;
    [SerializeField] private Rigidbody2D rb;

    private static readonly int SpeedHash = Animator.StringToHash("Speed");
    private static readonly int GroundedHash = Animator.StringToHash("IsGrounded");
    private static readonly int DashingHash = Animator.StringToHash("IsDashing");
    private static readonly int YVelHash = Animator.StringToHash("YVelocity");
    private static readonly int IsDeadHash = Animator.StringToHash("IsDead");

    private void Update()
    {
        if (animator.GetBool(IsDeadHash)) return;

        var vx = rb.linearVelocity.x;
        var speed01 = Mathf.Abs(vx);

        spriteRenderer.flipX = motor.FacingX < 0f;

        animator.SetFloat(SpeedHash, speed01);
        animator.SetBool(GroundedHash, motor.IsGrounded);
        animator.SetFloat(YVelHash, rb.linearVelocity.y);
        animator.SetBool(DashingHash, motor.IsDashingVisual);
    }

    public void RestartJumpAnimation()
    {
        animator.Play("Jump", 0, 0f);
    }

    public void RestartDashAnimation()
    {
        animator.Play("Dash", 0, 0f);
    }
}
