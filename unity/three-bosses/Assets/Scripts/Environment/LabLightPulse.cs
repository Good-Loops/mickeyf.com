using UnityEngine;

[RequireComponent(typeof(SpriteRenderer))]
public sealed class LabLightPulse : MonoBehaviour
{
    [SerializeField] private float speed = 2f;
    [SerializeField] private float minAlpha = 0.2f;
    [SerializeField] private float maxAlpha = 0.6f;

    private SpriteRenderer sr;

    private void Awake()
    {
        sr = GetComponent<SpriteRenderer>();
    }

    private void Update()
    {
        float t = (Mathf.Sin(Time.time * speed) + 1f) * 0.5f;
        float alpha = Mathf.Lerp(minAlpha, maxAlpha, t);

        Color c = sr.color;
        c.a = alpha;
        sr.color = c;
    }
}
