using UnityEngine;

[DisallowMultipleComponent]
[RequireComponent(typeof(HealthComponent))]
public sealed class GenericDamageReceiver : MonoBehaviour, IDamageable
{
    [Header("Optional")]
    [SerializeField] private MonoBehaviour invulnerabilitySource;

    private HealthComponent health;
    private IInvulnerabilitySource invulnerability;

    private void Awake()
    {
        health = GetComponent<HealthComponent>();
        if (invulnerabilitySource != null)
            invulnerability = invulnerabilitySource as IInvulnerabilitySource;
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (health == null) health = GetComponent<HealthComponent>();
    }
#endif

    public bool TryTakeDamage(int amount, Vector2 hitPoint, Vector2 hitNormal, GameObject instigator)
    {
        if (amount <= 0) return false;
        if (health == null || health.IsDead) return false;
        if (invulnerability != null && invulnerability.IsInvulnerable) return false;

        // Ignore enemy-owned damage
        var src = instigator != null ? instigator.GetComponentInParent<DamageSource>() : null;
        if (src != null && src.Faction == DamageFaction.Enemy) return false;

        return health.TryTakeDamage(amount);
    }
}
