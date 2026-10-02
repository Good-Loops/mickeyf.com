using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Shared behavior for the two lightweight transition scenes. Each scene owns
/// only its one background texture, while active-combat timing remains paused.
/// </summary>
[RequireComponent(typeof(OutcomeScreenView))]
[DefaultExecutionOrder(100)]
public sealed class BossTransitionScreenController : MonoBehaviour
{
    [SerializeField] private BossId expectedPendingBoss = BossId.Cyborg;
    [SerializeField] private string destinationSceneName = "Level2_CyborgBoss";
    [SerializeField, Min(0f)] private float displaySeconds = 4f;
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;
    [SerializeField] private OutcomeScreenView view;

    private void Start()
    {
        view ??= GetComponent<OutcomeScreenView>();
        if (view == null || !view.IsReady)
        {
            Debug.LogError("Transition screen UI is not configured.", this);
            return;
        }
        RunSession session = RunSessionService.Instance.Session;
        if (session.Phase != RunPhase.Transitioning || session.PendingBoss != expectedPendingBoss)
        {
            Debug.LogError(
                $"Transition expected {expectedPendingBoss}, but run is {session.Phase} with {session.PendingBoss} pending.",
                this);
            SceneManager.LoadScene("MainMenu");
            return;
        }

        view.SetValues(RunUiFormatter.FormatTime(session.GetBossSplitSeconds(session.CurrentBoss)));
        view.FadeOut(fadeDurationSeconds);
        StartCoroutine(ContinueAfterDelay());
    }

    private IEnumerator ContinueAfterDelay()
    {
        float visibleSeconds = Mathf.Max(0f, displaySeconds - fadeDurationSeconds);
        if (visibleSeconds > 0f)
            yield return new WaitForSecondsRealtime(visibleSeconds);

        view.FadeIn(fadeDurationSeconds);
        if (fadeDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);

        SceneManager.LoadScene(destinationSceneName);
    }
}
