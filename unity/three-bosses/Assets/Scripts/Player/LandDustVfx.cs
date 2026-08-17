using UnityEngine;

public sealed class LandDustVfx : MonoBehaviour
{
    [SerializeField] private ParticleSystem landDustPrefab;
    [SerializeField] private Transform spawnPoint;

    public void Play()
    {
        if (!landDustPrefab || !spawnPoint) return;

        var ps = Instantiate(landDustPrefab, spawnPoint.position, Quaternion.identity);
        ps.Play();

        var m = ps.main;
        Destroy(ps.gameObject, m.duration + m.startLifetime.constantMax + 0.2f);
    }
}
