using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class ShrapnelSlugProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Burst")]
    [SerializeField] private GameObject shrapnelPrefab;
    [SerializeField, Min(1)] private int shrapnelCount = 10;
    [SerializeField, Min(0.1f)] private float shrapnelSpeed = 14f;

    [Header("Safety")]
    [SerializeField, Min(0f)]
    private float minSpawnDistance = 0.05f;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 10;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private bool initialized;
    private bool hasBurst;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
    }

    public void SetImpactSfx(AudioClip clip, float volume)
    {
        impactSfx = clip;
        impactSfxVolume = Mathf.Clamp01(volume);
    }

    public void Init(
        Vector2 dir,
        float speed,
        GameObject impactPrefab
    )
    {
        this.impactPrefab = impactPrefab;

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
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (!initialized || hasBurst)
            return;

        hasBurst = true;

        DamageUtils2D.TryDealDamage(
            collision,
            damageAmount,
            gameObject
        );

        Vector2 hitPoint =
            collision.contactCount > 0
                ? collision.GetContact(0).point
                : transform.position;

        Vector2 surfaceNormal =
            collision.contactCount > 0
                ? collision.GetContact(0).normal
                : Vector2.up;

        SpawnImpactVfx(hitPoint, surfaceNormal);

        SpawnShrapnel(
            hitPoint,
            collision.collider
        );

        // One composite sound for the slug hit and shard burst.
        SfxPlayer.PlayOneShot(
            impactSfx,
            impactSfxVolume
        );

        Destroy(gameObject);
    }

    private void SpawnImpactVfx(
        Vector2 hitPoint,
        Vector2 surfaceNormal
    )
    {
        if (impactPrefab == null)
            return;

        Quaternion rotation =
            Quaternion.FromToRotation(
                Vector3.up,
                surfaceNormal
            );

        Instantiate(
            impactPrefab,
            hitPoint,
            rotation
        );
    }

    private void SpawnShrapnel(
        Vector2 hitPoint,
        Collider2D hitCollider
    )
    {
        if (shrapnelPrefab == null || shrapnelCount <= 0)
            return;

        float angleStep = 360f / shrapnelCount;

        for (int i = 0; i < shrapnelCount; i++)
        {
            float angle = i * angleStep;
            float radians = angle * Mathf.Deg2Rad;

            Vector2 direction = new(
                Mathf.Cos(radians),
                Mathf.Sin(radians)
            );

            Vector2 spawnPosition =
                hitPoint +
                direction * minSpawnDistance;

            GameObject shard = Instantiate(
                shrapnelPrefab,
                spawnPosition,
                Quaternion.identity
            );

            if (
                shard.TryGetComponent(
                    out ShrapnelShardProjectile shardProjectile
                )
            )
            {
                shardProjectile.IgnoreColliderTemporarily(
                    hitCollider,
                    0.10f
                );

                shardProjectile.Init(
                    direction,
                    shrapnelSpeed,
                    null
                );
            }
            else if (
                shard.TryGetComponent(
                    out Rigidbody2D shardRb
                )
            )
            {
                shardRb.linearVelocity =
                    direction * shrapnelSpeed;
            }
        }
    }
}