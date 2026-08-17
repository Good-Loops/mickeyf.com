using UnityEngine;

public sealed class DashTrailVfx : MonoBehaviour
{
    [SerializeField] private ParticleSystem dashTrailPrefab;
    [SerializeField] private Transform spawnPoint;
    [SerializeField] private SpriteRenderer spriteRenderer;
    [SerializeField] private float xOffset = 0.25f;

    public void Play()
    {
        if (!dashTrailPrefab || !spawnPoint || !spriteRenderer) return;

        var p = spawnPoint.localPosition;
        p.x = spriteRenderer.flipX ? +xOffset : -xOffset;
        spawnPoint.localPosition = p;

        var ps = Instantiate(dashTrailPrefab, spawnPoint.position, Quaternion.identity);
        ps.Play();

        var m = ps.main;
        Destroy(ps.gameObject, m.duration + m.startLifetime.constantMax + 0.2f);
    }
}
