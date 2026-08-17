using UnityEngine;

public sealed class LightningArcShot : MonoBehaviour, IProjectile
{
    [Header("VFX Prefabs")]
    [SerializeField] private GameObject arcVfxPrefab;     // your looping 64x16 arc VFX prefab
    [SerializeField] private float arcLifetime = 0.14f;

    [Header("Impact")]
    [SerializeField] private float impactForwardOffset = 0.02f;

    [Header("Offsets")]
    [SerializeField] private float startOffset = 0.02f;
    [SerializeField] private float endOffset = 0.02f;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 30;

    // Cache boss lookup so we don't Find every shot.
    private static BossTarget cachedBoss;

    public void Init(Vector2 dir, float speed, GameObject impactPrefab)
    {
        // speed is intentionally ignored (hitscan weapon)
        // dir is also optional here, since boss is the target, but we keep signature clean.

        var boss = GetBoss();
        if (boss == null)
        {
            Debug.LogWarning("LightningArcShot: No BossTarget found in scene.");
            Destroy(gameObject);
            return;
        }

        Vector3 start = transform.position;
        Vector3 end = boss.AimPoint.position;

        if (damageAmount > 0)
        {
            var damageable = boss.GetComponentInParent<IDamageable>();
            if (damageable != null)
            {
                Vector2 hitPoint = end;
                Vector2 hitNormal = (end - start).normalized;

                damageable.TryTakeDamage(
                    damageAmount,
                    hitPoint,
                    hitNormal,
                    gameObject
                );
            }
        }

        SpawnArc(start, end);
        SpawnImpact(end, start, impactPrefab);

        Destroy(gameObject); // This carrier object is done immediately.
    }

    private static BossTarget GetBoss()
    {
        if (cachedBoss != null) return cachedBoss;

        cachedBoss = FindFirstObjectByType<BossTarget>();
        return cachedBoss;
    }

    private void SpawnArc(Vector3 start, Vector3 end)
    {
        if (arcVfxPrefab == null) return;

        Vector3 delta = end - start;
        float dist = delta.magnitude;
        if (dist <= 0.0001f) return;

        Vector3 dirN = delta.normalized;

        start += dirN * startOffset;   // small positive offset
        end   -= dirN * endOffset;     // small trim before impact

        delta = end - start;
        dist  = delta.magnitude;

        var arc = Instantiate(arcVfxPrefab);

        float angle = Mathf.Atan2(delta.y, delta.x) * Mathf.Rad2Deg;
        arc.transform.rotation = Quaternion.Euler(0f, 0f, angle);

        // --- correct scaling ---
        var sr = arc.GetComponent<SpriteRenderer>();
        if (sr == null || sr.sprite == null)
        {
            Debug.LogError("LightningArcShot: arcVfxPrefab missing SpriteRenderer/sprite.");
            Destroy(arc);
            return;
        }

        float spriteWorldLength = sr.sprite.bounds.size.x; // already in world units
        if (spriteWorldLength <= 0.0001f)
        {
            Destroy(arc);
            return;
        }

        float xScale = dist / spriteWorldLength;

        // midpoint placement is fine once scale is correct
        arc.transform.position = (start + end) * 0.5f;
        arc.transform.localScale = new Vector3(xScale, 1f, 1f);

        Destroy(arc, arcLifetime);
    }

    private void SpawnImpact(Vector3 end, Vector3 start, GameObject impactPrefab)
    {
        if (impactPrefab == null) return;

        Vector3 dir = (end - start);
        if (dir.sqrMagnitude > 0.0001f)
            end += dir.normalized * impactForwardOffset;

        Instantiate(impactPrefab, end, Quaternion.identity);
    }
}
