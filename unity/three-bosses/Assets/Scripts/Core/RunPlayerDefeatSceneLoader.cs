using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Records the first valid player death, lets the existing death animation begin,
/// then opens the reusable boss-specific defeat screen.
/// </summary>
public sealed class RunPlayerDefeatSceneLoader : MonoBehaviour
{
    [SerializeField] private HealthComponent playerHealth;
    [SerializeField] private string defeatSceneName = "Defeat";
    [SerializeField, Min(0f)] private float loadDelaySeconds = 1.5f;
    [SerializeField, Min(0f)] private float fadeStartDelaySeconds = 0.75f;
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.5f;
    [SerializeField] private ScreenFade screenFade;

    private bool hasStartedTransition;

    private void OnEnable()
    {
        if (playerHealth != null)
            playerHealth.Died += OnPlayerDied;
    }

    private void OnDisable()
    {
        if (playerHealth != null)
            playerHealth.Died -= OnPlayerDied;
    }

    private void OnPlayerDied()
    {
        if (hasStartedTransition || !RunSessionService.Instance.Session.RecordDeath())
            return;

        hasStartedTransition = true;
        StartCoroutine(LoadDefeatScreen());
    }

    private IEnumerator LoadDefeatScreen()
    {
        if (fadeStartDelaySeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeStartDelaySeconds);

        if (screenFade != null)
            screenFade.FadeIn(fadeDurationSeconds);

        float remainingDelay = Mathf.Max(0f, loadDelaySeconds - fadeStartDelaySeconds);
        if (remainingDelay > 0f)
            yield return new WaitForSecondsRealtime(remainingDelay);

        if (string.IsNullOrWhiteSpace(defeatSceneName))
        {
            Debug.LogError("No defeat scene is configured.", this);
            yield break;
        }

        SceneManager.LoadScene(defeatSceneName);
    }
}
