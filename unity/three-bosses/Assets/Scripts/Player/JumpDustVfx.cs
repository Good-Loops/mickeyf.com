using UnityEngine;

public sealed class JumpDustVfx : MonoBehaviour
{
    [SerializeField] private ParticleSystem jumpDustPrefab;
    [SerializeField] private Transform spawnPoint;

    public void Play()
    {
        if (!jumpDustPrefab || !spawnPoint) return;

        var ps = Instantiate(jumpDustPrefab, spawnPoint.position, Quaternion.identity);
        ps.Play();

        var m = ps.main;
        Destroy(ps.gameObject, m.duration + m.startLifetime.constantMax + 0.2f);
    }
}
