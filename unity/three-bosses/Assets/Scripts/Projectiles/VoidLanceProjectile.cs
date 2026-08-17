using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class VoidLanceProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Lifetime")]
    [SerializeField, Min(0.1f)]
    private float lifeSeconds = 3f;

    [Header("Trail")]
    [SerializeField] private GameObject trailPrefab;

    [SerializeField, Min(0.01f)]
    private float trailSpawnInterval = 0.03f;

    [SerializeField]
    private Vector2 trailLocalOffset = new(-0.15f, 0f);

    [Header("Damage")]
    [SerializeField] private int damageAmount = 50;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private float trailTimer;

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

        trailTimer = 0f;
        initialized = true;

        Destroy(gameObject, lifeSeconds);
    }

    private void Update()
    {
        if (
            !initialized ||
            hasImpacted ||
            trailPrefab == null
        )
        {
            return;
        }

        trailTimer -= Time.deltaTime;

        if (trailTimer > 0f)
            return;

        trailTimer = trailSpawnInterval;

        Vector3 spawnPosition =
            transform.TransformPoint(trailLocalOffset);

        Instantiate(
            trailPrefab,
            spawnPosition,
            transform.rotation
        );
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
}