using UnityEngine;

public sealed class Boss2AnimationEvents : MonoBehaviour
{
    [SerializeField] private Boss2Controller controller;

    private void Awake()
    {
        if (controller == null)
            controller = GetComponentInParent<Boss2Controller>();
    }

    public void FireProjectile()
    {
        controller?.FireProjectile();
    }

    public void EndAttack()
    {
        controller?.EndAttack();
    }

    public void EndGroundSlam()
    {
        controller?.EndGroundSlam();
    }

    public void PerformGroundSlamHit()
    {
        controller?.PerformGroundSlamHit();
    }
}
