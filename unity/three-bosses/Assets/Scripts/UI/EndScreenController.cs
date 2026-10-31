using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;

/// <summary>
/// Displays the canonical completion result and delegates optional WebGL
/// submission to the persistent run-session service.
/// </summary>
[RequireComponent(typeof(OutcomeScreenView))]
[DefaultExecutionOrder(100)]
public sealed class EndScreenController : MonoBehaviour
{
    private const string UnrankedLabel = "UNRANKED";

    [SerializeField] private OutcomeScreenView view;
    [SerializeField] private string firstLevelSceneName = "Level1_BeeBoss";
    [SerializeField] private string menuSceneName = "MainMenu";
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;

    private bool isNavigating;
    private RunSessionService runSessionService;

    private void OnEnable()
    {
        view ??= GetComponent<OutcomeScreenView>();
        if (view == null || !view.IsReady)
        {
            Debug.LogError("End screen UI is not configured.", this);
            enabled = false;
            return;
        }
        view.TryAgainButton.clicked += TryAgain;
        view.BackToMenuButton.clicked += BackToMenu;
        view.SubmitScoreButton.clicked += SubmitScore;
        view.SubmitScoreButton.SetEnabled(false);

        runSessionService = RunSessionService.Instance;
        runSessionService.SubmissionStateChanged += RefreshSubmitButton;
    }

    private void OnDisable()
    {
        if (view != null)
        {
            if (view.TryAgainButton != null)
                view.TryAgainButton.clicked -= TryAgain;
            if (view.BackToMenuButton != null)
                view.BackToMenuButton.clicked -= BackToMenu;
            if (view.SubmitScoreButton != null)
                view.SubmitScoreButton.clicked -= SubmitScore;
        }

        if (runSessionService != null)
            runSessionService.SubmissionStateChanged -= RefreshSubmitButton;
    }

    private void Start()
    {
        Time.timeScale = 1f;
        RunSession session = runSessionService.Session;
        if (session.Phase != RunPhase.Completed)
        {
            Debug.LogError($"End screen opened while run phase is {session.Phase}.", this);
            SceneManager.LoadScene(menuSceneName);
            return;
        }

        if (!session.HasResult)
        {
            double elapsedSeconds = session.ElapsedSeconds;
            int completionTimeMilliseconds = elapsedSeconds > 0d &&
                                             !double.IsNaN(elapsedSeconds) &&
                                             !double.IsInfinity(elapsedSeconds)
                ? RunScoreCalculator.CanonicalizeCompletionTimeMilliseconds(elapsedSeconds)
                : 0;
            int score = completionTimeMilliseconds > 0
                ? RunScoreCalculator.CalculateFromMilliseconds(completionTimeMilliseconds)
                : 0;

            if (score == 0)
                Debug.LogWarning("Completed run has no positive elapsed time; using an unranked zero score.", this);

            string rank = score > 0
                ? RunRankCalculator.CalculateFromMilliseconds(completionTimeMilliseconds)
                : UnrankedLabel;
            session.TrySetResult(score, rank);
        }

        view.SetValues(RunUiFormatter.FormatTime(session.ElapsedSeconds), session.Score.ToString("N0"), session.Rank);

        runSessionService.RefreshRunSubmissionState();
        RefreshSubmitButton();
        view.FadeOut(fadeDurationSeconds);
        view.FocusFirstAction();
    }

    private void TryAgain()
    {
        if (isNavigating)
            return;

        runSessionService.Session.BeginNewRun();
        StartCoroutine(Navigate(firstLevelSceneName));
    }

    private void SubmitScore()
    {
        if (isNavigating)
            return;

        if (runSessionService.SubmissionRequiresNewRun)
        {
            TryAgain();
            return;
        }

        runSessionService.TrySubmitCurrentRun();
        RefreshSubmitButton();
    }

    private void RefreshSubmitButton()
    {
        if (view == null || runSessionService == null)
            return;

        RunSubmissionStatus status = runSessionService.SubmissionStatus;
        bool canSubmit = !isNavigating &&
            (status == RunSubmissionStatus.Ready ||
             status == RunSubmissionStatus.SignInRequired ||
             status == RunSubmissionStatus.RetryableFailure ||
             runSessionService.SubmissionRequiresNewRun);

        string label = status switch
        {
            RunSubmissionStatus.Ready => "SUBMIT SCORE",
            RunSubmissionStatus.Submitting => "SUBMITTING...",
            RunSubmissionStatus.Submitted => "SUBMITTED",
            RunSubmissionStatus.SignInRequired => "SIGN IN REQUIRED",
            RunSubmissionStatus.RetryableFailure => "RETRY SUBMISSION",
            RunSubmissionStatus.Rejected when
                runSessionService.SubmissionRequiresNewRun =>
                "START A NEW RUN",
            RunSubmissionStatus.Rejected => "SUBMISSION FAILED",
            _ => "SUBMISSION LOCKED"
        };

        view.SetSubmission(label, canSubmit);
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
