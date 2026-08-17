using UnityEngine;

public interface IDamageable
{
    /// <summary>
    /// Apply damage to this target.
    /// Returns true if damage was accepted (e.g., not already dead / immune).
    /// </summary>
    bool TryTakeDamage(int amount, Vector2 hitPoint, Vector2 hitNormal, GameObject instigator);
}
