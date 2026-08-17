using UnityEngine;

public sealed class BossAnimationEvents : MonoBehaviour
{
    [SerializeField] private BossShooter shooter;
    [SerializeField] private BossController controller;

    private void Awake()
    {
        if (shooter == null) shooter = GetComponentInParent<BossShooter>();
        if (controller == null) controller = GetComponentInParent<BossController>();
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (shooter == null) shooter = GetComponentInParent<BossShooter>();
        if (controller == null) controller = GetComponentInParent<BossController>();
    }
#endif

    public void AE_HurtEnd() => controller?.OnHurtAnimComplete();
    public void AE_AttackEnd() => controller?.OnAttackAnimComplete();
    public void AE_DeathEnd() => controller?.OnDeathAnimComplete();

    public void AE_Fire()
    {
        if (shooter == null || controller == null) return;
        shooter.FireBurst(controller.CurrentShotsPerAttack);
    }
}
