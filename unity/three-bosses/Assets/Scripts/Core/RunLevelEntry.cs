using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Commits a pending boss transition only when the destination battle scene exists.
/// Directly opening Level 2 or 3 in the Editor creates an unranked practice run.
/// </summary>
[DefaultExecutionOrder(-1000)]
public sealed class RunLevelEntry : MonoBehaviour
{
    [SerializeField] private BossId bossId = BossId.Bee;
    [SerializeField] private SceneFadeInOnStart sceneFadeIn;
    [SerializeField, Min(0f)] private float fallbackRevealDurationSeconds = 1f;
    [SerializeField] private string invalidStateSceneName = "MainMenu";

    private Coroutine entryRoutine;
    private float previousTimeScale;
    private bool ownsTimePause;

    private void Awake()
    {
        if (sceneFadeIn == null)
            sceneFadeIn = FindFirstObjectByType<SceneFadeInOnStart>();

        PauseGameplay();
        entryRoutine = StartCoroutine(EnterAfterReveal());
    }

    private void OnDisable()
    {
        if (entryRoutine != null)
        {
            StopCoroutine(entryRoutine);
            entryRoutine = null;
        }

        RestoreGameplay();
    }

    private IEnumerator EnterAfterReveal()
    {
        float revealDuration = sceneFadeIn != null
            ? sceneFadeIn.RevealDurationSeconds
            : fallbackRevealDurationSeconds;

        if (revealDuration > 0f)
            yield return new WaitForSecondsRealtime(revealDuration);

        // Let the fade component render its fully revealed frame before gameplay resumes.
        yield return null;

        RunSession session = RunSessionService.Instance.Session;
        bool activated;

        if (session.Phase == RunPhase.NotStarted)
        {
            session.BeginPractice(bossId);
            activated = session.Phase == RunPhase.Running && session.CurrentBoss == bossId;
        }
        else if (bossId == BossId.Bee)
        {
            activated = session.Phase == RunPhase.Running && session.CurrentBoss == BossId.Bee;
        }
        else
        {
            activated = session.EnterNextBoss(bossId) ||
                        (session.Phase == RunPhase.Running && session.CurrentBoss == bossId);
        }

        if (!activated)
        {
            Debug.LogError(
                $"Cannot enter {bossId}: run is {session.Phase}, current {session.CurrentBoss}, pending {session.PendingBoss}.",
                this);

            entryRoutine = null;
            RestoreGameplay();

            if (!string.IsNullOrWhiteSpace(invalidStateSceneName))
                SceneManager.LoadScene(invalidStateSceneName);

            yield break;
        }

        RestoreGameplay();
        entryRoutine = null;
    }

    private void PauseGameplay()
    {
        if (ownsTimePause)
            return;

        previousTimeScale = Time.timeScale;
        Time.timeScale = 0f;
        ownsTimePause = true;
    }

    private void RestoreGameplay()
    {
        if (!ownsTimePause)
            return;

        Time.timeScale = previousTimeScale;
        ownsTimePause = false;
    }
}
