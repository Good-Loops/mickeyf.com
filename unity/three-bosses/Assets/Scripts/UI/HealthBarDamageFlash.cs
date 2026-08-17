using System.Collections;
using UnityEngine;
using UnityEngine.UI;

public sealed class HealthBarDamageFlash : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private Image frameImage;
    [SerializeField] private Image fillImage;

    [Header("Tuning")]
    [SerializeField, Min(0.01f)] private float flashSeconds = 0.10f;
    [SerializeField, Range(0f, 1f)] private float intensity = 0.75f;

    private Color frameBase;
    private Color fillBase;
    private Coroutine routine;

    private void Awake()
    {
        if (frameImage != null) frameBase = frameImage.color;
        if (fillImage != null) fillBase = fillImage.color;
    }

    public void Play()
    {
        if (routine != null) StopCoroutine(routine);
        routine = StartCoroutine(Flash());
    }

    private IEnumerator Flash()
    {
        if (frameImage == null && fillImage == null) yield break;

        var t = 0f;

        while (t < flashSeconds)
        {
            t += Time.unscaledDeltaTime;
            var a = 1f - (t / flashSeconds);

            if (frameImage != null)
                frameImage.color = Color.Lerp(frameBase, Color.red, a * intensity);

            if (fillImage != null)
                fillImage.color = Color.Lerp(fillBase, Color.red, a * intensity);

            yield return null;
        }

        if (frameImage != null) frameImage.color = frameBase;
        if (fillImage != null) fillImage.color = fillBase;
        routine = null;
    }
}
