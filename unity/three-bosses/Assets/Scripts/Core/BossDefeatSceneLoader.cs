using System.Collections;
using UnityEngine;
using UnityEngine.SceneManagement;

public sealed class BossDefeatSceneLoader : MonoBehaviour
{
    [SerializeField] private HealthComponent bossHealth;
    [SerializeField] private string nextSceneName;

    [Header("Timing")]
    [SerializeField, Min(0f)] private float loadDelaySeconds = 5f;
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.75f;
    [SerializeField, Min(0f)] private float fadeStartDelaySeconds = 0.5f;

    [Header("Optional")]
    [SerializeField] private ScreenFade screenFade;

    private bool hasStartedTransition;

    private void OnEnable()
    {
        if (bossHealth != null)
            bossHealth.Died += OnBossDied;
    }

    private void OnDisable()
    {
        if (bossHealth != null)
            bossHealth.Died -= OnBossDied;
    }

    private void OnBossDied()
    {
        if (hasStartedTransition)
            return;

        hasStartedTransition = true;
        StartCoroutine(LoadSceneAfterDelay());
    }

    private IEnumerator LoadSceneAfterDelay()
    {
         if (fadeStartDelaySeconds > 0f)
            yield return new WaitForSeconds(fadeStartDelaySeconds);

        if (screenFade != null)
            screenFade.FadeIn(fadeDurationSeconds);

        float remainingDelay = Mathf.Max(0f, loadDelaySeconds - fadeStartDelaySeconds);
        if (remainingDelay > 0f)
            yield return new WaitForSeconds(remainingDelay);

        SceneManager.LoadScene(nextSceneName);
    }
}
