using UnityEngine;

[RequireComponent(typeof(HealthComponent))]
public sealed class PlayerDamageReceiver : MonoBehaviour, IDamageable
{
    [SerializeField] private HealthComponent health;

    private void Awake()
    {
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
        if (amount <= 0) return false;
        if (health == null || health.IsDead) return false;

        var src = instigator != null ? instigator.GetComponentInParent<DamageSource>() : null;
        if (src != null && src.Faction == DamageFaction.Player) return false;

        return health.TryTakeDamage(amount);
    }
}
