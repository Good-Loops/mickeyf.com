using UnityEngine;

[DisallowMultipleComponent]
[RequireComponent(typeof(HealthComponent))]
public sealed class BossDamageReceiver : MonoBehaviour, IDamageable
{
    [SerializeField] private BossController controller;
    private HealthComponent health;

    private void Awake()
    {
        if (controller == null) controller = GetComponentInParent<BossController>();
        health = GetComponent<HealthComponent>();
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (health == null) health = GetComponent<HealthComponent>();
    }
#endif

    public bool TryTakeDamage(int amount, Vector2 hitPoint, Vector2 hitNormal, GameObject instigator)
    {
        if (controller != null && controller.IsInvulnerable) return false;
        if (amount <= 0) return false;
        if (health == null || health.IsDead) return false;

        // Ignore enemy-owned damage (future-proof: bosses/enemies shouldn't hurt each other)
        var src = instigator != null ? instigator.GetComponentInParent<DamageSource>() : null;
        if (src != null && src.Faction == DamageFaction.Enemy) return false;

        return health.TryTakeDamage(amount);
    }
}
