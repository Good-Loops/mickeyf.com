using System.Collections;
using UnityEngine;
using UnityEngine.UI;

public sealed class ScreenFade : MonoBehaviour
{
    [SerializeField] private Image fadeImage;
    [SerializeField, Range(0f, 1f)] private float initialAlpha = 0f;

    private Coroutine activeFade;

    private void Awake()
    {
        if (fadeImage == null)
            fadeImage = GetComponent<Image>();

        SetAlpha(initialAlpha);
    }

    public void FadeIn(float duration)
    {
        StartFade(GetAlpha(), 1f, duration);
    }

    public void FadeOut(float duration)
    {
        StartFade(GetAlpha(), 0f, duration);
    }

    private void StartFade(float from, float to, float duration)
    {
        if (activeFade != null)
            StopCoroutine(activeFade);

        activeFade = StartCoroutine(FadeRoutine(from, to, duration));
    }

    private IEnumerator FadeRoutine(float from, float to, float duration)
    {
        if (duration <= 0f)
        {
            SetAlpha(to);
            yield break;
        }

        float elapsed = 0f;
        SetAlpha(from);

        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            float t = Mathf.Clamp01(elapsed / duration);
            SetAlpha(Mathf.Lerp(from, to, t));
            yield return null;
        }

        SetAlpha(to);
        activeFade = null;
    }

    private float GetAlpha()
    {
        if (fadeImage == null)
            return 0f;

        return fadeImage.color.a;
    }

    private void SetAlpha(float alpha)
    {
        if (fadeImage == null)
            return;

        Color color = fadeImage.color;
        color.a = alpha;
        fadeImage.color = color;
    }
}
