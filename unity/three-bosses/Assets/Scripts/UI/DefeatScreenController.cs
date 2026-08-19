using System.Collections;
using TMPro;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

/// <summary>
/// Shared behavior for the three lightweight boss-specific defeat scenes.
/// </summary>
public sealed class DefeatScreenController : MonoBehaviour
{
    [SerializeField] private BossId expectedBoss = BossId.Bee;
    [SerializeField] private TMP_Text timeSurvivedLabel;
    [SerializeField] private Button tryAgainButton;
    [SerializeField] private Button backToMenuButton;
    [SerializeField] private ScreenFade screenFade;
    [SerializeField] private string firstLevelSceneName = "Level1_BeeBoss";
    [SerializeField] private string menuSceneName = "MainMenu";
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;

    private bool isNavigating;

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
        if (session.Phase != RunPhase.Defeated || session.CurrentBoss != expectedBoss)
        {
            Debug.LogError(
                $"Defeat screen expected {expectedBoss}, but run is {session.Phase} at {session.CurrentBoss}.",
                this);
            SceneManager.LoadScene(menuSceneName);
            return;
        }

        timeSurvivedLabel.text = RunUiFormatter.FormatTime(session.ElapsedSeconds);
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
        screenFade?.FadeIn(fadeDurationSeconds);

        if (fadeDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);

        SceneManager.LoadScene(sceneName);
    }
}
