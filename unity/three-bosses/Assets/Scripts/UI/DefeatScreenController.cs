using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Shared behavior for the three lightweight boss-specific defeat scenes.
/// </summary>
[RequireComponent(typeof(OutcomeScreenView))]
[DefaultExecutionOrder(100)]
public sealed class DefeatScreenController : MonoBehaviour
{
    [SerializeField] private BossId expectedBoss = BossId.Bee;
    [SerializeField] private OutcomeScreenView view;
    [SerializeField] private string firstLevelSceneName = "Level1_BeeBoss";
    [SerializeField] private string menuSceneName = "MainMenu";
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;

    private bool isNavigating;

    private void OnEnable()
    {
        view ??= GetComponent<OutcomeScreenView>();
        if (view == null || !view.IsReady)
        {
            Debug.LogError("Defeat screen UI is not configured.", this);
            enabled = false;
            return;
        }
        view.TryAgainButton.clicked += TryAgain;
        view.BackToMenuButton.clicked += BackToMenu;
    }

    private void OnDisable()
    {
        if (view == null)
            return;
        if (view.TryAgainButton != null)
            view.TryAgainButton.clicked -= TryAgain;
        if (view.BackToMenuButton != null)
            view.BackToMenuButton.clicked -= BackToMenu;
    }

    private void Start()
    {
        Time.timeScale = 1f;
        RunSession session = RunSessionService.Instance.Session;
        if (session.Phase != RunPhase.Defeated || session.CurrentBoss != expectedBoss)
        {
            Debug.LogError(
                $"Defeat screen expected {expectedBoss}, but run is {session.Phase} at {session.CurrentBoss}.",
                this);
            SceneManager.LoadScene(menuSceneName);
            return;
        }

        view.SetValues(RunUiFormatter.FormatTime(session.ElapsedSeconds));
        view.FadeOut(fadeDurationSeconds);
        view.FocusFirstAction();
    }

    private void TryAgain()
    {
        if (isNavigating)
            return;

        RunSessionService.Instance.Session.BeginNewRun();
        StartCoroutine(Navigate(firstLevelSceneName));
    }

    private void BackToMenu()
    {
        if (isNavigating)
            return;

        StartCoroutine(Navigate(menuSceneName));
    }

    private IEnumerator Navigate(string sceneName)
    {
        isNavigating = true;
        view.SetNavigationEnabled(false);
        view.FadeIn(fadeDurationSeconds);

        if (fadeDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);

        SceneManager.LoadScene(sceneName);
    }
}
