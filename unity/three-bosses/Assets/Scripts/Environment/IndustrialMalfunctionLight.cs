using UnityEngine;

[RequireComponent(typeof(SpriteRenderer))]
public sealed class IndustrialMalfunctionLight : MonoBehaviour
{
    [Header("Alpha Range")]
    [SerializeField, Range(0f, 1f)] private float minAlpha = 0.05f;
    [SerializeField, Range(0f, 1f)] private float maxAlpha = 0.28f;

    [Header("Timing")]
    [SerializeField, Min(0.01f)] private float minHoldTime = 0.04f;
    [SerializeField, Min(0.01f)] private float maxHoldTime = 0.14f;

    [Header("Behavior")]
    [SerializeField, Range(0f, 1f)] private float chanceToDropOut = 0.22f;
    [SerializeField] private bool randomizeOnStart = true;

    private SpriteRenderer spriteRenderer;
    private float timer;
    private float currentHoldTime;

    private void Awake()
    {
        spriteRenderer = GetComponent<SpriteRenderer>();
    }

    private void OnEnable()
    {
        if (randomizeOnStart)
            ApplyRandomState();

        ResetTimer();
    }

    private void Update()
    {
        timer -= Time.deltaTime;
        if (timer > 0f)
            return;

        ApplyRandomState();
        ResetTimer();
    }

    private void ApplyRandomState()
    {
        float alpha = Random.value < chanceToDropOut
            ? minAlpha
            : Random.Range(minAlpha, maxAlpha);

        Color color = spriteRenderer.color;
        color.a = alpha;
        spriteRenderer.color = color;
    }

    private void ResetTimer()
    {
        currentHoldTime = Random.Range(minHoldTime, maxHoldTime);
        timer = currentHoldTime;
    }
}
