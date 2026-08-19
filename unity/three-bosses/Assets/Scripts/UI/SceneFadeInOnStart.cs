using System.Collections;
using UnityEngine;

public sealed class SceneFadeInOnStart : MonoBehaviour
{
    [SerializeField] private ScreenFade screenFade;
    [SerializeField, Min(0f)] private float fadeOutDuration = 0.9f;
    [SerializeField, Min(0f)] private float startDelay = 0.1f;

    public float RevealDurationSeconds =>
        Mathf.Max(0f, startDelay) + Mathf.Max(0f, fadeOutDuration);

    private void Awake()
    {
        if (screenFade == null)
            screenFade = GetComponent<ScreenFade>();
    }

    private void Start()
    {
        if (screenFade == null)
            return;

        StartCoroutine(BeginFadeOutAfterDelay());
    }

    private IEnumerator BeginFadeOutAfterDelay()
    {
        if (startDelay > 0f)
            yield return new WaitForSecondsRealtime(startDelay);

        if (screenFade == null)
            yield break;

        screenFade.FadeOut(fadeOutDuration);
    }
}
