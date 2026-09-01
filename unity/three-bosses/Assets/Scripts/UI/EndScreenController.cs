using System.Collections;
using TMPro;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

/// <summary>
/// Displays the canonical completion result and delegates optional WebGL
/// submission to the persistent run-session service.
/// </summary>
public sealed class EndScreenController : MonoBehaviour
{
    private const string UnrankedLabel = "UNRANKED";

    [SerializeField] private TMP_Text completionTimeLabel;
    [SerializeField] private TMP_Text scoreLabel;
    [SerializeField] private TMP_Text rankLabel;
    [SerializeField] private Button tryAgainButton;
    [SerializeField] private Button backToMenuButton;
    [SerializeField] private Button submitScoreButton;
    [SerializeField] private ScreenFade screenFade;
    [SerializeField] private string firstLevelSceneName = "Level1_BeeBoss";
    [SerializeField] private string menuSceneName = "MainMenu";
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;

    private bool isNavigating;
    private RunSessionService runSessionService;
    private TMP_Text submitScoreLabel;

    private void Awake()
    {
        UiButtonStyle.Apply(tryAgainButton);
        UiButtonStyle.Apply(backToMenuButton);
        UiButtonStyle.Apply(submitScoreButton);

        if (submitScoreButton != null)
        {
            submitScoreButton.interactable = false;
            submitScoreLabel = submitScoreButton.GetComponentInChildren<TMP_Text>();
        }
    }

    private void OnEnable()
    {
        tryAgainButton.onClick.AddListener(TryAgain);
        backToMenuButton.onClick.AddListener(BackToMenu);
        submitScoreButton.onClick.AddListener(SubmitScore);

        runSessionService = RunSessionService.Instance;
        runSessionService.SubmissionStateChanged += RefreshSubmitButton;
    }

    private void OnDisable()
    {
        tryAgainButton.onClick.RemoveListener(TryAgain);
        backToMenuButton.onClick.RemoveListener(BackToMenu);
        submitScoreButton.onClick.RemoveListener(SubmitScore);

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

        completionTimeLabel.text = RunUiFormatter.FormatTime(session.ElapsedSeconds);
        scoreLabel.text = session.Score.ToString("N0");
        rankLabel.text = session.Rank;

        runSessionService.RefreshRunSubmissionState();
        RefreshSubmitButton();
        screenFade?.FadeOut(fadeDurationSeconds);
        EventSystem.current?.SetSelectedGameObject(tryAgainButton.gameObject);
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

        runSessionService.TrySubmitCurrentRun();
        RefreshSubmitButton();
    }

    private void RefreshSubmitButton()
    {
        if (submitScoreButton == null || runSessionService == null)
            return;

        RunSubmissionStatus status = runSessionService.SubmissionStatus;
        submitScoreButton.interactable = !isNavigating &&
            (status == RunSubmissionStatus.Ready ||
             status == RunSubmissionStatus.SignInRequired ||
             status == RunSubmissionStatus.RetryableFailure);

        string label = status switch
        {
            RunSubmissionStatus.Ready => "SUBMIT SCORE",
            RunSubmissionStatus.Submitting => "SUBMITTING...",
            RunSubmissionStatus.Submitted => "SUBMITTED",
            RunSubmissionStatus.SignInRequired => "SIGN IN REQUIRED",
            RunSubmissionStatus.RetryableFailure => "RETRY SUBMISSION",
            RunSubmissionStatus.Rejected when
                runSessionService.SubmissionErrorCode ==
                    RunSubmissionCoordinator.RunTicketUnavailableErrorCode =>
                "START A NEW RUN",
            RunSubmissionStatus.Rejected => "SUBMISSION FAILED",
            _ => "SUBMISSION LOCKED"
        };

        if (submitScoreLabel != null)
            submitScoreLabel.text = label;
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
        tryAgainButton.interactable = false;
        backToMenuButton.interactable = false;
        submitScoreButton.interactable = false;
        screenFade?.FadeIn(fadeDurationSeconds);

        if (fadeDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);

        SceneManager.LoadScene(sceneName);
    }
}
