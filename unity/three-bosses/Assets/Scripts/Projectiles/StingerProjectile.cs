using UnityEngine;

[RequireComponent(typeof(Rigidbody2D))]
public sealed class StingerProjectile : MonoBehaviour, IProjectile
{
    [SerializeField] private int damage = 10;
    [SerializeField] private GameObject impactPrefab;

    private Rigidbody2D rb;
    private DamageSource source;

    [SerializeField] private bool spriteFacesRight = false;

    [SerializeField] private LayerMask impactMask;      // Ground/Walls
    [SerializeField, Min(0.01f)] private float normalProbeDistance = 0.25f;

    private Vector2 lastDir = Vector2.right;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();

        // Ensure DamageSource exists
        source = GetComponent<DamageSource>();
        if (source == null)
            source = gameObject.AddComponent<DamageSource>();
    }

    public void Init(Vector2 dir, float speed, GameObject impactOverride)
    {
        if (impactOverride != null)
            impactPrefab = impactOverride;

        lastDir = dir.normalized;

        rb.linearVelocity = dir.normalized * speed;

        float angle = Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg;

        // If the sprite is drawn facing LEFT, add 180 degrees.
        if (!spriteFacesRight) angle += 180f;

        transform.rotation = Quaternion.Euler(0f, 0f, angle);
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        var damageable = other.GetComponentInParent<IDamageable>();
        if (damageable != null)
        {
            Vector2 p = other.ClosestPoint(transform.position);
            Vector2 n = ((Vector2)transform.position - p);
            if (n.sqrMagnitude < 0.0001f) n = lastDir;
            n.Normalize();

            damageable.TryTakeDamage(damage, p, n, gameObject);
            SpawnImpact(p, n);
            Destroy(gameObject);
            return;
        }

        // Environment hit: use raycast normal (gives UP on ground)
        if (TryGetSurfaceNormal(out var point, out var normal))
        {
            SpawnImpact(point, normal);
        }
        else
        {
            // fallback
            SpawnImpact(other.ClosestPoint(transform.position), Vector2.up);
        }

        Destroy(gameObject);
    }

    private void SpawnImpact(Vector2 point, Vector2 normal)
    {
        if (impactPrefab == null) return;

        var rot = Quaternion.FromToRotation(Vector2.up, normal);
        Instantiate(impactPrefab, point, rot);
    }

    private bool TryGetSurfaceNormal(out Vector2 point, out Vector2 normal)
    {
        // Cast from current position slightly forward, back toward the surface we just entered.
        Vector2 origin = (Vector2)transform.position + lastDir * 0.05f;
        Vector2 castDir = -lastDir;

        var hit = Physics2D.Raycast(origin, castDir, normalProbeDistance, impactMask);
        if (hit.collider != null)
        {
            point = hit.point;
            normal = hit.normal;
            return true;
        }

        point = transform.position;
        normal = Vector2.up;
        return false;
    }
}
