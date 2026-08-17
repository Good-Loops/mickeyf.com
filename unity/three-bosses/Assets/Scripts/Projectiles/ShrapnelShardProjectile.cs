using System.Collections;
using UnityEngine;

[RequireComponent(typeof(Rigidbody2D), typeof(Collider2D))]
public sealed class ShrapnelShardProjectile :
    MonoBehaviour,
    IProjectile
{
    [Header("Lifetime")]
    [SerializeField] private float maxLifetime = 0.4f;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 10;

    private Rigidbody2D rb;
    private Collider2D col2d;

    private bool initialized;
    private bool hasImpacted;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        col2d = GetComponent<Collider2D>();
    }

    public void Init(
        Vector2 dir,
        float speed,
        GameObject impactPrefab
    )
    {
        Vector2 direction = dir.normalized;

        rb.gravityScale = 0f;
        rb.collisionDetectionMode =
            CollisionDetectionMode2D.Continuous;

        rb.linearVelocity = direction * speed;

        float angle =
            Mathf.Atan2(direction.y, direction.x) *
            Mathf.Rad2Deg;

        transform.rotation =
            Quaternion.Euler(0f, 0f, angle);

        initialized = true;

        Destroy(gameObject, maxLifetime);
    }

    public void IgnoreColliderTemporarily(
        Collider2D other,
        float seconds
    )
    {
        if (other == null)
            return;

        StartCoroutine(
            IgnoreRoutine(other, seconds)
        );
    }

    private IEnumerator IgnoreRoutine(
        Collider2D other,
        float seconds
    )
    {
        Physics2D.IgnoreCollision(
            col2d,
            other,
            true
        );

        yield return new WaitForSeconds(seconds);

        if (col2d != null && other != null)
        {
            Physics2D.IgnoreCollision(
                col2d,
                other,
                false
            );
        }
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (!initialized || hasImpacted)
            return;

        hasImpacted = true;

        DamageUtils2D.TryDealDamage(
            collision,
            damageAmount,
            gameObject
        );

        Destroy(gameObject);
    }
}