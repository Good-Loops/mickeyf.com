using System.Collections;
using UnityEngine;

public sealed class WeaponCrateSpawner : MonoBehaviour
{
    [Header("Prefab")]
    [SerializeField] private GameObject weaponCratePrefab;

    [Header("Timing")]
    [SerializeField, Min(0.1f)] private float spawnIntervalSeconds = 15f;
    [SerializeField] private bool spawnImmediatelyOnStart = true;

    [Header("Spawn Area (World Space)")]
    [SerializeField] private bool deriveFromMainCamera = true;
    [SerializeField] private float minX = -8f;
    [SerializeField] private float maxX = 8f;
    [SerializeField] private float spawnY = 8f;
    [SerializeField] private float spawnMarginAboveScreen = 1.5f;

    [Header("Spawn Safety")]
    [SerializeField, Min(0f)] private float horizontalInset = 1.5f;

    [Header("Limits (Optional)")]
    [SerializeField, Min(0)] private int maxAlive = 3;

    private int aliveCount;
    private Coroutine loop;
    private float crateHalfHeightWorld;
    private bool initialized;

    private void Start()
    {
        EnsureInitialized();
    }

    private void EnsureInitialized()
    {
        if (initialized) return;

        CacheCrateHalfHeight();

        if (deriveFromMainCamera)
            ConfigureFromCamera();

        initialized = true;
    }

    private void CacheCrateHalfHeight()
    {
        if (weaponCratePrefab == null) return;

        // Prefer Renderer bounds (accounts for sprite size); fallback to Collider.
        var r = weaponCratePrefab.GetComponentInChildren<Renderer>();
        if (r != null)
        {
            crateHalfHeightWorld = r.bounds.extents.y;
            return;
        }

        var c = weaponCratePrefab.GetComponentInChildren<Collider2D>();
        if (c != null)
        {
            crateHalfHeightWorld = c.bounds.extents.y;
            return;
        }

        // Last resort: small default so we still spawn above screen.
        crateHalfHeightWorld = 0.5f;
    }

    private void OnEnable()
    {
        EnsureInitialized();
        loop = StartCoroutine(SpawnLoop());
    }

    private void OnDisable()
    {
        if (loop != null)
            StopCoroutine(loop);
    }

    private IEnumerator SpawnLoop()
    {
        if (spawnImmediatelyOnStart)
            TrySpawn();

        while (true)
        {
            yield return new WaitForSeconds(spawnIntervalSeconds);
            TrySpawn();
        }
    }

    private void ConfigureFromCamera()
    {
        Camera cam = Camera.main;
        if (cam == null || !cam.orthographic)
            return;

        float halfHeight = cam.orthographicSize;
        float halfWidth = halfHeight * cam.aspect;

        minX = cam.transform.position.x - halfWidth;
        maxX = cam.transform.position.x + halfWidth;

        float cameraTopY = cam.transform.position.y + halfHeight;
        spawnY = cameraTopY + spawnMarginAboveScreen + crateHalfHeightWorld;
    }

    private void TrySpawn()
    {
        if (weaponCratePrefab == null)
        {
            Debug.LogError("WeaponCrateSpawner: Missing prefab reference.", this);
            return;
        }

        if (maxAlive > 0 && aliveCount >= maxAlive)
            return;

        float x = GetRandomSpawnX();
        Vector3 pos = new Vector3(x, spawnY, 0f);

        GameObject crate = Instantiate(weaponCratePrefab, pos, Quaternion.identity);
        aliveCount++;

        var tracker = crate.AddComponent<SpawnedCrateTracker>();
        tracker.Init(this);
    }

    private float GetRandomSpawnX()
    {
        float safeMinX = minX + horizontalInset;
        float safeMaxX = maxX - horizontalInset;

        if (safeMinX >= safeMaxX)
            return minX;

        return Random.Range(safeMinX, safeMaxX);
    }

    private void NotifyCrateDestroyed()
    {
        aliveCount = Mathf.Max(0, aliveCount - 1);
    }

    private sealed class SpawnedCrateTracker : MonoBehaviour
    {
        private WeaponCrateSpawner owner;

        public void Init(WeaponCrateSpawner spawner)
        {
            owner = spawner;
        }

        private void OnDestroy()
        {
            owner?.NotifyCrateDestroyed();
        }
    }
}
