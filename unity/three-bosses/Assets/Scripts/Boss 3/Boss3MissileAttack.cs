using UnityEngine;

public sealed class Boss3MissileAttack : MonoBehaviour
{
    [Header("References")]
    [SerializeField] private Transform firePoint;
    [SerializeField] private GameObject missilePrefab;
    [SerializeField] private Transform playerTarget;

    [Header("Triple Shot")]
    [SerializeField] private float sideSpawnOffset = 0.35f;
    [SerializeField] private float sideArcAmplitude = 2.5f;
    [SerializeField] private float sideArcFrequency = 1.5f;

    private bool isPaused;
    private bool isCancelled;

    public void Fire()
    {
        if (isPaused || isCancelled) return;

        if (firePoint == null || missilePrefab == null || playerTarget == null)
        {
            Debug.LogWarning("Boss3MissileAttack is missing references.", this);
            return;
        }

        Vector2 directionToPlayer = (playerTarget.position - firePoint.position).normalized;
        Vector2 perpendicular = new Vector2(-directionToPlayer.y, directionToPlayer.x).normalized;

        FireCenterMissile(directionToPlayer);
        FireCurvedMissile(directionToPlayer, perpendicular * sideSpawnOffset, sideArcAmplitude);
        FireCurvedMissile(directionToPlayer, -perpendicular * sideSpawnOffset, -sideArcAmplitude);
    }

    private void FireCenterMissile(Vector2 direction)
    {
        if (isPaused || isCancelled) return;

        GameObject missileObj = Instantiate(missilePrefab, firePoint.position, Quaternion.identity);

        if (missileObj.TryGetComponent<ArcaneMissileProjectile>(out var missile))
        {
            missile.Initialize(direction);
        }
    }

    private void FireCurvedMissile(Vector2 direction, Vector2 spawnOffset, float amplitude)
    {
        if (isPaused || isCancelled) return;

        Vector3 spawnPosition = firePoint.position + (Vector3)spawnOffset;
        GameObject missileObject = Instantiate(missilePrefab, spawnPosition, Quaternion.identity);

        if (missileObject.TryGetComponent<ArcaneMissileProjectile>(out var missile))
        {
            missile.Initialize(direction, true, amplitude, sideArcFrequency);
        }
    }

    public void SetPaused(bool paused)
    {
        isPaused = paused;
    }

    public void CancelAttack()
    {
        isCancelled = true;
    }

    public void BeginAttack()
    {
        isCancelled = false;
        isPaused = false;
    }
}
