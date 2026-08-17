using UnityEngine;

public sealed class SceneFadeInOnStart : MonoBehaviour
{
    [SerializeField] private ScreenFade screenFade;
    [SerializeField, Min(0f)] private float fadeOutDuration = 0.9f;
    [SerializeField, Min(0f)] private float startDelay = 0.1f;

    private void Awake()
    {
        if (screenFade == null)
            screenFade = GetComponent<ScreenFade>();
    }

    private void Start()
    {
        if (screenFade == null)
            return;

        if (startDelay <= 0f)
        {
            screenFade.FadeOut(fadeOutDuration);
            return;
        }

        Invoke(nameof(BeginFadeOut), startDelay);
    }

    private void BeginFadeOut()
    {
        if (screenFade == null)
            return;

        screenFade.FadeOut(fadeOutDuration);
    }
}
