using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class TimeFractureBeamProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Damage")]
    [SerializeField] private int damageAmount = 40;

    [Header("Freeze")]
    [SerializeField, Min(0f)]
    private float freezeSeconds = 2f;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private bool initialized;
    private bool hasImpacted;

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

        Vector2 normalizedDirection = dir.normalized;

        rb.gravityScale = 0f;
        rb.collisionDetectionMode =
            CollisionDetectionMode2D.Continuous;

        rb.linearVelocity =
            normalizedDirection * speed;

        float angle =
            Mathf.Atan2(
                normalizedDirection.y,
                normalizedDirection.x
            ) * Mathf.Rad2Deg;

        transform.rotation =
            Quaternion.Euler(0f, 0f, angle);

        initialized = true;
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

        IBossEffectReceiver boss =
            GetBossEffectReceiver(collision.collider);

        if (boss != null && !boss.IsInvulnerable)
        {
            boss.ApplyFreeze(freezeSeconds);
        }

        SpawnImpactVfx(collision);

        SfxPlayer.PlayOneShot(
            impactSfx,
            impactSfxVolume
        );

        Destroy(gameObject);
    }

    private void SpawnImpactVfx(Collision2D collision)
    {
        if (impactPrefab == null)
            return;

        Vector3 impactPosition = transform.position;
        Quaternion impactRotation = transform.rotation;

        if (collision.contactCount > 0)
        {
            ContactPoint2D contact =
                collision.GetContact(0);

            impactPosition = contact.point;

            impactRotation =
                Quaternion.FromToRotation(
                    Vector3.right,
                    -contact.normal
                );
        }

        Instantiate(
            impactPrefab,
            impactPosition,
            impactRotation
        );
    }

    private static IBossEffectReceiver GetBossEffectReceiver(
        Collider2D hitCollider
    )
    {
        MonoBehaviour[] behaviours =
            hitCollider.GetComponentsInParent<MonoBehaviour>();

        foreach (MonoBehaviour behaviour in behaviours)
        {
            if (behaviour is IBossEffectReceiver effectReceiver)
            {
                return effectReceiver;
            }
        }

        return null;
    }
}