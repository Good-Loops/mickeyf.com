using UnityEngine;

[RequireComponent(typeof(Collider2D))]
public sealed class Boss3RuneExplosion : MonoBehaviour
{
    [Header("Damage")]
    [SerializeField] private int damageAmount = 2;
    [SerializeField] private float totalLifeSeconds = 0.5f;
    [SerializeField] private LayerMask hitLayers;

    private Collider2D hitbox;
    private float remainingLife;
    private float activeDamageTime;
    private bool damageWindowOpen;

    private void Awake()
    {
        hitbox = GetComponent<Collider2D>();
        hitbox.isTrigger = true;
        hitbox.enabled = false;
    }

    public void Initialize(float activeDuration)
    {
        remainingLife = totalLifeSeconds;
        activeDamageTime = activeDuration;
        damageWindowOpen = true;
        hitbox.enabled = true;
    }

    private void Update()
    {
        float deltaTime = Time.deltaTime;

        remainingLife -= deltaTime;
        if (remainingLife <= 0f)
        {
            Destroy(gameObject);
            return;
        }

        if (!damageWindowOpen)
        {
            return;
        }

        activeDamageTime -= deltaTime;
        if (activeDamageTime <= 0f)
        {
            damageWindowOpen = false;
            hitbox.enabled = false;
        }
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (!damageWindowOpen)
        {
            return;
        }

        if (!IsInHitLayers(other.gameObject.layer))
        {
            return;
        }

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

        Vector2 hitPoint = other.ClosestPoint(transform.position);
        Vector2 hitNormal = Vector2.up;

        damageable.TryTakeDamage(damageAmount, hitPoint, hitNormal, gameObject);
    }

    private bool IsInHitLayers(int layer)
    {
        return (hitLayers.value & (1 << layer)) != 0;
    }
}
