using UnityEngine;
using UnityEngine.UI;

public sealed class HealthBarLowHealthPulse : MonoBehaviour
{
    [SerializeField] private Image fillImage;
    [SerializeField, Range(0.05f, 0.5f)] private float minAlpha = 0.25f;
    [SerializeField, Min(0.1f)] private float pulseHz = 2.0f;

    private float health01 = 1f;
    private float baseAlpha;

    private void Awake()
    {
        if (fillImage != null) baseAlpha = fillImage.color.a;
    }

    public void SetHealth01(float t) => health01 = Mathf.Clamp01(t);

    private void Update()
    {
        if (fillImage == null) return;

        if (health01 >= 0.25f)
        {
            SetAlpha(baseAlpha);
            return;
        }

        var s = (Mathf.Sin(Time.unscaledTime * Mathf.PI * 2f * pulseHz) + 1f) * 0.5f; // 0..1
        var a = Mathf.Lerp(minAlpha, 1f, s);
        SetAlpha(a);
    }

    private void SetAlpha(float alpha)
    {
        // Damage feedback owns the RGB tint on this same image.
        Color color = fillImage.color;
        color.a = alpha;
        fillImage.color = color;
    }
}
