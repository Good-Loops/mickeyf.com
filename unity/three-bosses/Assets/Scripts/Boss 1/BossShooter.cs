using UnityEngine;

public sealed class BossShooter : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private Transform attackSpawn;
    [SerializeField] private Transform target;

    [Header("Projectile")]
    [SerializeField] private GameObject projectilePrefab;
    [SerializeField, Min(0.1f)] private float projectileSpeed = 12f;
    [SerializeField, Range(0f, 25f)]
    private float burstSpreadDegrees = 8f;

    private int lastFireFrame = -1;

    private bool isPaused;
    public void SetPaused(bool paused) { isPaused = paused; }

    private void FireOnce(Vector2 dir)
    {
        if (projectilePrefab == null || attackSpawn == null) return;

        Vector2 from = attackSpawn.position;
        if (dir.sqrMagnitude < 0.0001f) dir = Vector2.right;

        var go = Instantiate(projectilePrefab, from, Quaternion.identity);

        var p = go.GetComponent<IProjectile>();
        if (p != null)
        {
            p.Init(dir.normalized, projectileSpeed, impactPrefab: null);
            return;
        }

        var rb = go.GetComponent<Rigidbody2D>();
        if (rb != null)
            rb.linearVelocity = dir.normalized * projectileSpeed;
    }

    public void FireBurst(int shots)
    {
        if (isPaused) return;

        if (lastFireFrame == Time.frameCount) return;
        lastFireFrame = Time.frameCount;

        shots = Mathf.Max(1, shots);

        Vector2 from = attackSpawn.position;
        Vector2 to = target != null ? (Vector2)target.position : (from + Vector2.right);
        Vector2 baseDir = (to - from).normalized;
        if (baseDir.sqrMagnitude < 0.0001f) baseDir = Vector2.right;

        if (shots == 1)
        {
            FireOnce(baseDir);
            return;
        }

        float half = (shots - 1) * 0.5f;
        for (int i = 0; i < shots; i++)
        {
            float offset = i - half;
            float angle = offset * (burstSpreadDegrees / Mathf.Max(1, shots - 1));
            Vector2 dir = Rotate(baseDir, angle);
            FireOnce(dir);
        }
    }

    private static Vector2 Rotate(Vector2 v, float degrees)
    {
        float rad = degrees * Mathf.Deg2Rad;
        float s = Mathf.Sin(rad);
        float c = Mathf.Cos(rad);
        return new Vector2(v.x * c - v.y * s, v.x * s + v.y * c);
    }
}
