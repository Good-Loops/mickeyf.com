using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class RicochetDiskProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Lifetime")]
    [SerializeField] private float lifeSeconds = 4f;

    [Header("Bounce")]
    [SerializeField] private int maxBounces = 3;

    [SerializeField, Range(0.5f, 1f)]
    private float bounceDamping = 0.88f;

    [Header("Spin (Visual)")]
    [SerializeField] private bool useConstantSpin = true;
    [SerializeField] private float spinDegreesPerSecond = 900f;
    [SerializeField] private bool faceVelocityWhenNotSpinning;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 20;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private int bouncesRemaining;
    private bool initialized;
    private bool isTerminating;

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

        rb.gravityScale = 0f;
        rb.collisionDetectionMode =
            CollisionDetectionMode2D.Continuous;

        rb.linearVelocity = dir.normalized * speed;

        if (!useConstantSpin && faceVelocityWhenNotSpinning)
        {
            UpdateRotationFromVelocity();
        }

        initialized = true;

        Destroy(gameObject, lifeSeconds);
    }

    private void Update()
    {
        if (!initialized || isTerminating)
            return;

        if (useConstantSpin)
        {
            transform.Rotate(
                0f,
                0f,
                spinDegreesPerSecond * Time.deltaTime
            );
        }
        else if (faceVelocityWhenNotSpinning)
        {
            UpdateRotationFromVelocity();
        }
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (!initialized || isTerminating)
            return;

        DamageUtils2D.TryDealDamage(
            collision,
            damageAmount,
            gameObject
        );

        PlayImpact(collision);

        // Once all permitted bounces have already been used,
        // this collision ends the projectile.
        if (bouncesRemaining <= 0)
        {
            isTerminating = true;
            Destroy(gameObject);
            return;
        }

        rb.linearVelocity *= bounceDamping;
        bouncesRemaining--;
    }

    private void PlayImpact(Collision2D collision)
    {
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
}