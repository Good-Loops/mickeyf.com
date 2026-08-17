using System.Collections;
using UnityEngine;

[RequireComponent(
    typeof(Rigidbody2D),
    typeof(Collider2D),
    typeof(AudioSource)
)]
public sealed class PhaseAnchorProjectile :
    MonoBehaviour,
    IProjectile,
    IImpactSfxReceiver
{
    [Header("Lifetime")]
    [SerializeField] private float maxLifeSeconds = 4f;
    [SerializeField] private float anchoredLifeSeconds = 5f;

    [Header("Stick")]
    [SerializeField] private float stickSeparation = 0.03f;
    [SerializeField] private bool destroyOnAnchorEnd = true;

    [Header("Stick Visual")]
    [SerializeField] private Transform visual;
    [SerializeField] private Transform sinkPart;
    [SerializeField] private float sinkDistance = 0.10f;

    [Header("Zone")]
    [SerializeField] private GameObject zonePrefab;

    [Header("Anchor Rules")]
    [SerializeField] private LayerMask anchorSurfaceMask;

    [Header("Damage")]
    [SerializeField] private int damageAmount = 25;

    [Header("Field Audio")]
    [SerializeField] private AudioClip fieldLoopSfx;
    [SerializeField] private AudioClip fieldEndSfx;

    [SerializeField, Range(0f, 1f)]
    private float fieldLoopSfxVolume = 0.45f;

    [SerializeField, Range(0f, 1f)]
    private float fieldEndSfxVolume = 0.8f;

    [SerializeField, Min(0f)]
    private float fieldLoopStartDelay = 0.35f;

    [SerializeField, Min(0f)]
    private float fieldLoopFadeInSeconds = 0.15f;

    [SerializeField, Min(0f)]
    private float fieldLoopFadeOutSeconds = 0.08f;

    private Rigidbody2D rb;
    private Collider2D col;
    private AudioSource fieldAudioSource;

    private GameObject impactPrefab;
    private PhaseAnchorZone zoneInstance;

    private AudioClip impactSfx;
    private float impactSfxVolume = 1f;

    private Coroutine fieldLoopRoutine;

    private bool initialized;
    private bool anchored;
    private bool hasStuck;
    private bool isEnding;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        col = GetComponent<Collider2D>();

        fieldAudioSource = GetComponent<AudioSource>();

        // Defensive fallback for prefabs created before AudioSource
        // became a required component.
        if (fieldAudioSource == null)
        {
            fieldAudioSource = gameObject.AddComponent<AudioSource>();
        }

        fieldAudioSource.playOnAwake = false;
        fieldAudioSource.loop = true;
        fieldAudioSource.spatialBlend = 0f;
        fieldAudioSource.dopplerLevel = 0f;
    }

    public void SetImpactSfx(AudioClip clip, float volume)
    {
        impactSfx = clip;
        impactSfxVolume = Mathf.Clamp01(volume);
    }

    public void Init(
        Vector2 dir,
        float speed,
        GameObject impactPrefab
    )
    {
        this.impactPrefab = impactPrefab;

        rb.collisionDetectionMode =
            CollisionDetectionMode2D.Continuous;

        rb.gravityScale = 0f;
        rb.linearVelocity = dir.normalized * speed;

        initialized = true;

        // Unlike Destroy(gameObject, delay), this can be canceled
        // when the projectile successfully anchors.
        Invoke(nameof(ExpireInFlight), maxLifeSeconds);
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (
            !initialized ||
            anchored ||
            hasStuck ||
            isEnding
        )
        {
            return;
        }

        DamageUtils2D.TryDealDamage(
            collision,
            damageAmount,
            gameObject
        );

        if (!IsInMask(collision.gameObject.layer, anchorSurfaceMask))
        {
            Destroy(gameObject);
            return;
        }

        anchored = true;
        hasStuck = true;

        CancelInvoke(nameof(ExpireInFlight));

        ContactPoint2D contact =
            collision.contactCount > 0
                ? collision.GetContact(0)
                : default;

        Vector2 normal =
            collision.contactCount > 0
                ? contact.normal
                : Vector2.up;

        Vector2 point =
            collision.contactCount > 0
                ? contact.point
                : (Vector2)transform.position;

        float angle =
            Mathf.Atan2(normal.y, normal.x) *
            Mathf.Rad2Deg;

        Quaternion zoneRotation =
            Quaternion.Euler(0f, 0f, angle - 90f);

        if (impactPrefab != null)
        {
            Instantiate(
                impactPrefab,
                point,
                zoneRotation
            );
        }

        if (
            TryGetBossEffectReceiver(
                collision.collider,
                out IBossEffectReceiver boss,
                out Transform bossTransform
            )
        )
        {
            transform.SetParent(
                bossTransform,
                worldPositionStays: true
            );

            CreateZone(
                point,
                zoneRotation,
                bossTransform,
                boss
            );
        }

        Stick(point, normal);

        // Attachment and activation sound.
        SfxPlayer.PlayOneShot(
            impactSfx,
            impactSfxVolume
        );

        StartFieldLoop();

        Invoke(
            nameof(EndAnchor),
            anchoredLifeSeconds
        );
    }

    private void CreateZone(
        Vector2 position,
        Quaternion rotation,
        Transform parent,
        IBossEffectReceiver boss
    )
    {
        if (zonePrefab == null)
            return;

        GameObject zoneObject = Instantiate(
            zonePrefab,
            position,
            rotation,
            parent
        );

        zoneObject.SetActive(true);

        zoneInstance =
            zoneObject.GetComponent<PhaseAnchorZone>();

        if (zoneInstance != null)
        {
            zoneInstance.Init(boss);
        }
    }

    private void Stick(
        Vector2 hitPoint,
        Vector2 surfaceNormal
    )
    {
        transform.position =
            hitPoint +
            surfaceNormal * stickSeparation;

        // Make the object's right side point into the surface.
        Vector2 intoSurface = -surfaceNormal;

        float rotationZ =
            Mathf.Atan2(
                intoSurface.y,
                intoSurface.x
            ) * Mathf.Rad2Deg;

        transform.rotation =
            Quaternion.Euler(0f, 0f, rotationZ);

        rb.linearVelocity = Vector2.zero;
        rb.angularVelocity = 0f;
        rb.bodyType = RigidbodyType2D.Kinematic;
        rb.simulated = false;

        col.enabled = false;

        if (sinkPart != null)
        {
            StartCoroutine(SinkRoutine());
        }
    }

    private IEnumerator SinkRoutine()
    {
        const float duration = 0.08f;

        float elapsed = 0f;

        Vector3 startPosition =
            sinkPart.localPosition;

        Vector3 targetPosition =
            startPosition +
            new Vector3(sinkDistance, 0f, 0f);

        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;

            float progress =
                Mathf.Clamp01(elapsed / duration);

            sinkPart.localPosition =
                Vector3.Lerp(
                    startPosition,
                    targetPosition,
                    progress
                );

            yield return null;
        }

        sinkPart.localPosition = targetPosition;
    }

    private void StartFieldLoop()
    {
        if (fieldLoopSfx == null)
            return;

        if (fieldLoopRoutine != null)
        {
            StopCoroutine(fieldLoopRoutine);
        }

        fieldLoopRoutine =
            StartCoroutine(FieldLoopRoutine());
    }

    private IEnumerator FieldLoopRoutine()
    {
        if (fieldLoopStartDelay > 0f)
        {
            yield return new WaitForSeconds(
                fieldLoopStartDelay
            );
        }

        if (!anchored || isEnding)
            yield break;

        fieldAudioSource.clip = fieldLoopSfx;
        fieldAudioSource.volume =
            fieldLoopFadeInSeconds > 0f
                ? 0f
                : fieldLoopSfxVolume;

        fieldAudioSource.Play();

        if (fieldLoopFadeInSeconds <= 0f)
            yield break;

        float elapsed = 0f;

        while (
            elapsed < fieldLoopFadeInSeconds &&
            !isEnding
        )
        {
            elapsed += Time.deltaTime;

            float progress = Mathf.Clamp01(
                elapsed / fieldLoopFadeInSeconds
            );

            fieldAudioSource.volume =
                Mathf.Lerp(
                    0f,
                    fieldLoopSfxVolume,
                    progress
                );

            yield return null;
        }

        if (!isEnding)
        {
            fieldAudioSource.volume =
                fieldLoopSfxVolume;
        }
    }

    private void EndAnchor()
    {
        if (isEnding)
            return;

        isEnding = true;

        if (zoneInstance != null)
        {
            Destroy(zoneInstance.gameObject);
            zoneInstance = null;
        }

        StartCoroutine(EndAnchorRoutine());
    }

    private IEnumerator EndAnchorRoutine()
    {
        if (fieldLoopRoutine != null)
        {
            StopCoroutine(fieldLoopRoutine);
            fieldLoopRoutine = null;
        }

        if (fieldAudioSource.isPlaying)
        {
            float startingVolume =
                fieldAudioSource.volume;

            if (fieldLoopFadeOutSeconds > 0f)
            {
                float elapsed = 0f;

                while (elapsed < fieldLoopFadeOutSeconds)
                {
                    elapsed += Time.deltaTime;

                    float progress = Mathf.Clamp01(
                        elapsed /
                        fieldLoopFadeOutSeconds
                    );

                    fieldAudioSource.volume =
                        Mathf.Lerp(
                            startingVolume,
                            0f,
                            progress
                        );

                    yield return null;
                }
            }

            fieldAudioSource.Stop();
            fieldAudioSource.clip = null;
        }

        // Played globally so destroying the anchor does not
        // cut off the ending sound.
        SfxPlayer.PlayOneShot(
            fieldEndSfx,
            fieldEndSfxVolume
        );

        if (destroyOnAnchorEnd)
        {
            Destroy(gameObject);
        }
    }

    private void ExpireInFlight()
    {
        if (!anchored)
        {
            Destroy(gameObject);
        }
    }

    private static bool IsInMask(
        int layer,
        LayerMask mask
    )
    {
        return (mask.value & (1 << layer)) != 0;
    }

    private static bool TryGetBossEffectReceiver(
        Collider2D hitCollider,
        out IBossEffectReceiver receiver,
        out Transform receiverTransform
    )
    {
        receiver = null;
        receiverTransform = null;

        MonoBehaviour[] behaviours =
            hitCollider.GetComponentsInParent<MonoBehaviour>();

        foreach (MonoBehaviour behaviour in behaviours)
        {
            if (behaviour is not IBossEffectReceiver effectReceiver)
                continue;

            receiver = effectReceiver;
            receiverTransform = behaviour.transform;
            return true;
        }

        return false;
    }
}