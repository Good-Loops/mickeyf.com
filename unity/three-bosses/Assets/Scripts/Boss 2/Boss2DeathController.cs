using System.Collections;
using UnityEngine;

[DisallowMultipleComponent]
[RequireComponent(typeof(HealthComponent))]
public sealed class Boss2DeathController : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private HealthComponent health;
    [SerializeField] private Boss2Mover movement;
    [SerializeField] private Animator animator;
    [SerializeField] private SpriteRenderer visual;

    [Header("Animator")]
    [SerializeField] private string deathTriggerName = "Die";
    [SerializeField] private float deathAnimationSeconds = 1.2f;

    [Header("Remains")]
    [SerializeField] private BossRemains remainsPrefab;
    [SerializeField] private Transform remainsSpawnPoint;

    public bool IsDead { get; private set; }

    private void Awake()
    {
        if (health == null) health = GetComponent<HealthComponent>();
        if (movement == null) movement = GetComponent<Boss2Mover>();
        if (animator == null) animator = GetComponentInChildren<Animator>();
        if (visual == null) visual = GetComponentInChildren<SpriteRenderer>();
        if (remainsSpawnPoint == null) remainsSpawnPoint = transform;
    }

    private void OnEnable()
    {
        if (health != null)
            health.Died += OnDied;
    }

    private void OnDisable()
    {
        if (health != null)
            health.Died -= OnDied;
    }

    private void OnDied()
    {
        if (IsDead) return;
        IsDead = true;

        if (movement != null)
            movement.enabled = false;

        if (animator != null)
        {
            animator.speed = 1f;
            animator.SetTrigger(deathTriggerName);
        }

        StartCoroutine(DeathRoutine());
    }

    private IEnumerator DeathRoutine()
    {
        yield return new WaitForSeconds(deathAnimationSeconds);

        SpawnRemains();

        gameObject.SetActive(false);
    }

    private void SpawnRemains()
    {
        if (remainsPrefab == null || visual == null) return;

        Vector3 spawnPos = remainsSpawnPoint != null ? remainsSpawnPoint.position : transform.position;
        BossRemains remains = Instantiate(remainsPrefab, spawnPos, Quaternion.identity);

        SpriteRenderer remainsSr = remains.GetComponent<SpriteRenderer>();
        if (remainsSr != null)
        {
            remainsSr.flipX = visual.flipX;
        }

        remains.Init(visual.sprite);
    }
}
