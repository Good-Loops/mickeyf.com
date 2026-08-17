using UnityEngine;

public static class DamageUtils2D
{
    public static bool TryDealDamage(Collision2D collision, int damageAmount, GameObject instigator)
    {
        if (damageAmount <= 0) return false;

        var contact = collision.contactCount > 0 ? collision.GetContact(0) : default;
        Vector2 hitPoint  = collision.contactCount > 0 ? contact.point  : (Vector2)instigator.transform.position;
        Vector2 hitNormal = collision.contactCount > 0 ? contact.normal : Vector2.up;

        IDamageable damageable =
            (collision.rigidbody != null)
                ? collision.rigidbody.GetComponent<IDamageable>()
                : null;

        damageable ??= collision.collider.GetComponent<IDamageable>();

        if (damageable == null) return false;

        return damageable.TryTakeDamage(damageAmount, hitPoint, hitNormal, instigator);
    }

    public static bool TryDealDamage(Collider2D collider, int damageAmount, GameObject instigator)
    {
        if (damageAmount <= 0 || collider == null) return false;

        Vector2 hitPoint = collider.ClosestPoint(instigator.transform.position);
        Vector2 hitNormal = ((Vector2)collider.transform.position - hitPoint).normalized;

        if (hitNormal == Vector2.zero)
            hitNormal = Vector2.up;

        IDamageable damageable =
            (collider.attachedRigidbody != null)
                ? collider.attachedRigidbody.GetComponent<IDamageable>()
                : null;

        damageable ??= collider.GetComponent<IDamageable>();

        if (damageable == null) return false;

        return damageable.TryTakeDamage(damageAmount, hitPoint, hitNormal, instigator);
    }
}
