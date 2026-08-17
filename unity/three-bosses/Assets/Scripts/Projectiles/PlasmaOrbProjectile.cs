using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class PlasmaOrbProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Tuning")]
    [SerializeField] private float lifeSeconds = 4f;
    [SerializeField] private float gravityScale = 0.9f;
    [SerializeField] private int maxBounces = 1;
    [SerializeField] private float launchUpwardVelocity = 5f;
    [SerializeField] private float maxUpwardVelocity = 9f;
    [SerializeField] private float bounceNormalBoost = 9f;
    [SerializeField] private float minUpwardOnBounce = 7f;
    [SerializeField] private float bounceSeparation = 0.03f;
    [SerializeField] private float minBounceSpeed = 14f;

    [SerializeField, Range(0.5f, 1f)]
    private float bounceDamping = 0.95f;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 25;

    [Header("Hit Rules")]
    [SerializeField] private LayerMask explodeOnHitMask;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private int bouncesRemaining;
    private bool initialized;
    private bool hasExploded;

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

        bouncesRemaining = Mathf.Max(0, maxBounces);

        rb.gravityScale = gravityScale;
        rb.collisionDetectionMode = CollisionDetectionMode2D.Continuous;

        rb.linearVelocity = dir.normalized * speed;
        rb.linearVelocity += Vector2.up * launchUpwardVelocity;

        // Allow the projectile to pop upward while keeping it heavy.
        if (rb.linearVelocity.y > maxUpwardVelocity)
        {
            rb.linearVelocity = new Vector2(
                rb.linearVelocity.x,
                maxUpwardVelocity
            );
        }

        UpdateRotationFromVelocity();

        initialized = true;
        Destroy(gameObject, lifeSeconds);
    }

    private void FixedUpdate()
    {
        if (!initialized || hasExploded)
            return;

        UpdateRotationFromVelocity();
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (!initialized || hasExploded)
            return;

        bool shouldExplodeImmediately = IsInMask(
            collision.gameObject.layer,
            explodeOnHitMask
        );

        if (shouldExplodeImmediately)
        {
            Explode(collision);
            return;
        }

        // First ordinary collision reflects the orb.
        if (bouncesRemaining > 0)
        {
            Bounce(collision);
            return;
        }

        // After all available bounces have been used, detonate.
        Explode(collision);
    }

    private void Bounce(Collision2D collision)
    {
        bouncesRemaining--;

        Vector2 normal = collision.contactCount > 0
            ? collision.GetContact(0).normal
            : Vector2.up;

        Vector2 reflectedVelocity =
            Vector2.Reflect(rb.linearVelocity, normal) *
            bounceDamping;

        // Make sure the projectile moves away from the surface.
        reflectedVelocity += normal * bounceNormalBoost;

        if (
            normal.y > 0.7f &&
            reflectedVelocity.y < minUpwardOnBounce
        )
        {
            reflectedVelocity.y = minUpwardOnBounce;
        }

        float speed = reflectedVelocity.magnitude;

        if (speed < minBounceSpeed)
        {
            Vector2 fallbackDirection =
                reflectedVelocity.sqrMagnitude > 0.0001f
                    ? reflectedVelocity.normalized
                    : normal;

            reflectedVelocity =
                fallbackDirection * minBounceSpeed;
        }

        // Prevent an immediate second collision with the same surface.
        rb.position += normal * bounceSeparation;
        rb.linearVelocity = reflectedVelocity;

        UpdateRotationFromVelocity();
    }

    private void Explode(Collision2D collision)
    {
        if (hasExploded)
            return;

        hasExploded = true;

        DamageUtils2D.TryDealDamage(
            collision,
            damageAmount,
            gameObject
        );

        Vector3 impactPosition = transform.position;

        if (collision.contactCount > 0)
        {
            impactPosition = collision.GetContact(0).point;
        }

        if (impactPrefab != null)
        {
            Instantiate(
                impactPrefab,
                impactPosition,
                Quaternion.identity
            );
        }

        SfxPlayer.PlayOneShot(
            impactSfx,
            impactSfxVolume
        );

        Destroy(gameObject);
    }

    private void UpdateRotationFromVelocity()
    {
        Vector2 velocity = rb.linearVelocity;

        if (velocity.sqrMagnitude < 0.0001f)
            return;

        float angle =
            Mathf.Atan2(velocity.y, velocity.x) *
            Mathf.Rad2Deg;

        transform.rotation = Quaternion.Euler(
            0f,
            0f,
            angle
        );
    }

    private static bool IsInMask(int layer, LayerMask mask)
    {
        return (mask.value & (1 << layer)) != 0;
    }
}