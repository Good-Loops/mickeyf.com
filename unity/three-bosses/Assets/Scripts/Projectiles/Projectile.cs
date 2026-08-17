using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class Projectile : MonoBehaviour, IProjectile, IImpactSfxReceiver
{
    [SerializeField] private float lifeSeconds = 3f;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 25;

    private Rigidbody2D rb;
    private GameObject impactPrefab;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private bool hasImpacted;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
    }

    public void Init(Vector2 dir, float speed, GameObject impactPrefab)
    {
        this.impactPrefab = impactPrefab;

        rb.gravityScale = 0f;
        rb.collisionDetectionMode = CollisionDetectionMode2D.Continuous;
        rb.linearVelocity = dir.normalized * speed;

        // Visual rotation (right=0°, up=90°, left=180°)
        float angle = Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg;
        transform.rotation = Quaternion.Euler(0f, 0f, angle);

        Destroy(gameObject, lifeSeconds);
    }

    public void SetImpactSfx(AudioClip clip, float volume)
    {
        impactSfx = clip;
        impactSfxVolume = Mathf.Clamp01(volume);
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
         if (hasImpacted)
            return;

        hasImpacted = true;

        DamageUtils2D.TryDealDamage(collision, damageAmount, gameObject);

        Vector3 impactPosition = transform.position;

        if (collision.contactCount > 0)
            impactPosition = collision.GetContact(0).point;

        if (impactPrefab != null)
            Instantiate(impactPrefab, impactPosition, Quaternion.identity);

        SfxPlayer.PlayOneShot(
            impactSfx,
            impactSfxVolume
        );

        Destroy(gameObject);
    }
}
