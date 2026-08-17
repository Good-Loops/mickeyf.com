using UnityEngine;

public sealed class ArcaneMissileProjectile : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float speed = 6f;
    [SerializeField] private float lifeSeconds = 4f;

    [Header("Arc")]
    [SerializeField] private bool useArcMotion = false;
    [SerializeField] private float arcAmplitude = 1.25f;
    [SerializeField] private float arcFrequency = 1.5f;
    [SerializeField] private bool rotateAlongVelocity = true;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 1;
    [SerializeField] private LayerMask hitLayers;

    [Header("Impact")]
    [SerializeField] private GameObject impactPrefab;

    [Header("Visuals")]
    [SerializeField] private Transform visualRoot;
    [SerializeField] private float spriteForwardOffset = 0f;

    private Vector2 moveDirection = Vector2.right;
    private Vector2 lateralDirection = Vector2.up;

    private Vector3 basePosition;
    private float elapsedTime;
    private float remainingLife;
    private bool hasImpacted;

    private void Awake()
    {
        remainingLife = lifeSeconds;
    }

    public void Initialize(Vector2 direction)
    {
        Initialize(direction, false, 0f, 0f);
    }

    public void Initialize(Vector2 direction, bool curved, float amplitude, float frequency)
    {
        moveDirection = direction.normalized;
        lateralDirection = new Vector2(-moveDirection.y, moveDirection.x).normalized;

        useArcMotion = curved;
        arcAmplitude = amplitude;
        arcFrequency = frequency;

        basePosition = transform.position;
        elapsedTime = 0f;
        remainingLife = lifeSeconds;

        UpdateFacing(moveDirection);
    }

    private void Update()
    {
        float deltaTime = Time.deltaTime;
        elapsedTime += deltaTime;
        remainingLife -= deltaTime;

        if (remainingLife <= 0f)
        {
            Destroy(gameObject);
            return;
        }

        Vector3 previousPosition = transform.position;

        if (!useArcMotion)
        {
            transform.position += (Vector3)(deltaTime * speed * moveDirection);
        }
        else
        {
            float forwardDistance = speed * elapsedTime;
            float sidewaysOffset = Mathf.Sin(elapsedTime * arcFrequency) * arcAmplitude;

            Vector3 forward = (Vector3)(moveDirection * forwardDistance);
            Vector3 sideways = (Vector3)(lateralDirection * sidewaysOffset);

            transform.position = basePosition + forward + sideways;

            if (rotateAlongVelocity)
            {
                Vector2 velocity = ((Vector2)transform.position - (Vector2)previousPosition) / Mathf.Max(deltaTime, 0.0001f);
                if (velocity.sqrMagnitude > 0.0001f)
                {
                    UpdateFacing(velocity.normalized);
                }
            }
        }
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (hasImpacted)
        {
            return;
        }

        if (!IsInHitLayers(other.gameObject.layer))
        {
            return;
        }

        hasImpacted = true;

        Vector2 hitPoint = other.ClosestPoint(transform.position);
        Vector2 hitNormal = -moveDirection;

        TryDealDamage(other, hitPoint, hitNormal);
        SpawnImpact(hitPoint, hitNormal);

        Destroy(gameObject);
    }

    private bool IsInHitLayers(int layer)
    {
        return (hitLayers.value & (1 << layer)) != 0;
    }

    private void TryDealDamage(Collider2D other, Vector2 hitPoint, Vector2 hitNormal)
    {
        IDamageable damageable = null;

        if (other.attachedRigidbody != null)
        {
            damageable = other.attachedRigidbody.GetComponent<IDamageable>();
        }

        damageable ??= other.GetComponent<IDamageable>();

        if (damageable == null)
        {
            return;
        }

        damageable.TryTakeDamage(damageAmount, hitPoint, hitNormal, gameObject);
    }

    private void SpawnImpact(Vector2 position, Vector2 normal)
    {
        if (impactPrefab == null)
        {
            return;
        }

        float angle = Mathf.Atan2(normal.y, normal.x) * Mathf.Rad2Deg;
        Quaternion rotation = Quaternion.Euler(0f, 0f, angle + spriteForwardOffset);

        Instantiate(impactPrefab, position, rotation);
    }

    private void UpdateFacing(Vector2 direction)
    {
        float angle = Mathf.Atan2(direction.y, direction.x) * Mathf.Rad2Deg;
        Transform target = visualRoot != null ? visualRoot : transform;
        target.rotation = Quaternion.Euler(0f, 0f, angle + spriteForwardOffset);
    }
}
