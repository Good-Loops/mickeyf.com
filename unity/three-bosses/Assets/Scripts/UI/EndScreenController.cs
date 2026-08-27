using System.Collections;
using TMPro;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

/// <summary>
/// Displays the local completion result. Submission remains disabled until the
/// timing, ranking, and release gates approve the Unity-to-browser integration.
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

    private void Awake()
    {
        UiButtonStyle.Apply(tryAgainButton);
        UiButtonStyle.Apply(backToMenuButton);
        UiButtonStyle.Apply(submitScoreButton);

        // The browser endpoint exists, but Unity activation is a separate release gate.
        // Keep it inert before the first rendered frame as well as after Start.
        if (submitScoreButton != null)
            submitScoreButton.interactable = false;
    }

    private void OnEnable()
    {
        tryAgainButton.onClick.AddListener(TryAgain);
        backToMenuButton.onClick.AddListener(BackToMenu);
    }

    private void OnDisable()
    {
        tryAgainButton.onClick.RemoveListener(TryAgain);
        backToMenuButton.onClick.RemoveListener(BackToMenu);
    }

    private void Start()
    {
        Time.timeScale = 1f;
        RunSession session = RunSessionService.Instance.Session;
        if (session.Phase != RunPhase.Completed)
        {
            Debug.LogError($"End screen opened while run phase is {session.Phase}.", this);
            SceneManager.LoadScene(menuSceneName);
            return;
        }

        if (!session.HasResult)
        {
            double elapsedSeconds = session.ElapsedSeconds;
            int score = elapsedSeconds > 0d &&
                        !double.IsNaN(elapsedSeconds) &&
                        !double.IsInfinity(elapsedSeconds)
                ? RunScoreCalculator.Calculate(elapsedSeconds)
                : 0;

            if (score == 0)
                Debug.LogWarning("Completed run has no positive elapsed time; using an unranked zero score.", this);

            session.TrySetResult(score, UnrankedLabel);
        }

        completionTimeLabel.text = RunUiFormatter.FormatTime(session.ElapsedSeconds);
        scoreLabel.text = session.Score.ToString("N0");
        rankLabel.text = session.Rank;

        submitScoreButton.interactable = false;
        screenFade?.FadeOut(fadeDurationSeconds);
        EventSystem.current?.SetSelectedGameObject(tryAgainButton.gameObject);
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
        tryAgainButton.interactable = false;
        backToMenuButton.interactable = false;
        submitScoreButton.interactable = false;
        screenFade?.FadeIn(fadeDurationSeconds);

        if (fadeDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);

        SceneManager.LoadScene(sceneName);
    }
}
