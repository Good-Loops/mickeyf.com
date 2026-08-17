using UnityEngine;
using UnityEngine.UI;

public sealed class HealthBarLowHealthPulse : MonoBehaviour
{
    [SerializeField] private Image fillImage;
    [SerializeField, Range(0.05f, 0.5f)] private float minAlpha = 0.25f;
    [SerializeField, Min(0.1f)] private float pulseHz = 2.0f;

    private float health01 = 1f;
    private Color baseColor;

    private void Awake()
    {
        if (fillImage != null) baseColor = fillImage.color;
    }

    public void SetHealth01(float t) => health01 = Mathf.Clamp01(t);

    private void Update()
    {
        if (fillImage == null) return;

        if (health01 >= 0.25f)
        {
            fillImage.color = baseColor;
            return;
        }

        var s = (Mathf.Sin(Time.unscaledTime * Mathf.PI * 2f * pulseHz) + 1f) * 0.5f; // 0..1
        var a = Mathf.Lerp(minAlpha, 1f, s);
        var c = baseColor;
        c.a = a;
        fillImage.color = c;
    }
}
