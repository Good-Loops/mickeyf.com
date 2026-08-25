using System.Collections;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public sealed class MainMenuController : MonoBehaviour
{
    [SerializeField] private Button playButton;
    [SerializeField] private Button audioButton;
    [SerializeField] private AudioToggleIcon audioButtonIcon;
    [SerializeField] private string firstLevelSceneName = "Level1_BeeBoss";
    [SerializeField] private ScreenFade screenFade;
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.35f;

    private bool isLoading;

    private void Awake()
    {
        UiButtonStyle.Apply(playButton);
        UiButtonStyle.ApplyToGraphic(audioButton, audioButtonIcon);
    }

    private void OnEnable()
    {
        if (playButton != null)
            playButton.onClick.AddListener(StartNewRun);

        if (audioButton != null)
            audioButton.onClick.AddListener(ToggleAudio);

        GameAudioSettings.Changed += OnAudioChanged;
    }

    private void Start()
    {
        Time.timeScale = 1f;
        RefreshAudioIcon();

        if (playButton != null && EventSystem.current != null)
            EventSystem.current.SetSelectedGameObject(playButton.gameObject);
    }

    private void OnDisable()
    {
        if (playButton != null)
            playButton.onClick.RemoveListener(StartNewRun);

        if (audioButton != null)
            audioButton.onClick.RemoveListener(ToggleAudio);

        GameAudioSettings.Changed -= OnAudioChanged;
    }

    private void StartNewRun()
    {
        if (isLoading || string.IsNullOrWhiteSpace(firstLevelSceneName))
            return;

        isLoading = true;

        if (playButton != null)
            playButton.interactable = false;

        if (audioButton != null)
            audioButton.interactable = false;

        RunSessionService.Instance.Session.BeginNewRun();
        StartCoroutine(LoadFirstLevel());
    }

    private IEnumerator LoadFirstLevel()
    {
        if (screenFade != null && fadeDurationSeconds > 0f)
        {
            screenFade.FadeIn(fadeDurationSeconds);
            yield return new WaitForSecondsRealtime(fadeDurationSeconds);
        }

        SceneManager.LoadScene(firstLevelSceneName);
    }

    private void ToggleAudio()
    {
        GameAudioSettings.Toggle();
        RefreshAudioIcon();
    }

    private void OnAudioChanged(bool _)
    {
        RefreshAudioIcon();
    }

    private void RefreshAudioIcon()
    {
        if (audioButtonIcon != null)
            audioButtonIcon.SetAudioEnabled(GameAudioSettings.IsEnabled);
    }
}
