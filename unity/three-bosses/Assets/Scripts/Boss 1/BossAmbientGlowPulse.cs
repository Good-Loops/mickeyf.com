using UnityEngine;

[RequireComponent(typeof(SpriteRenderer))]
public sealed class BossAmbientGlowPulse : MonoBehaviour
{
    [Header("Alpha")]
    [SerializeField, Range(0f, 1f)] private float minAlpha = 0.35f;
    [SerializeField, Range(0f, 1f)] private float maxAlpha = 0.55f;

    [Header("Scale")]
    [SerializeField] private float minScaleMultiplier = 0.95f;
    [SerializeField] private float maxScaleMultiplier = 1.08f;

    [Header("Motion")]
    [SerializeField] private float pulseSpeed = 1.5f;

    private SpriteRenderer spriteRenderer;
    private Vector3 initialScale;

    private void Awake()
    {
        spriteRenderer = GetComponent<SpriteRenderer>();
        initialScale = transform.localScale;
    }

    private void Update()
    {
        float t = (Mathf.Sin(Time.time * pulseSpeed) + 1f) * 0.5f;

        float alpha = Mathf.Lerp(minAlpha, maxAlpha, t);
        float scaleMultiplier = Mathf.Lerp(minScaleMultiplier, maxScaleMultiplier, t);

        Color color = spriteRenderer.color;
        color.a = alpha;
        spriteRenderer.color = color;

        transform.localScale = initialScale * scaleMultiplier;
    }
}
