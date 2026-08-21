using System.Collections;
using ThreeBosses.Run;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;

public sealed class RunCountdownController : MonoBehaviour
{
    private static readonly Color ThreeColor = new(0.72f, 1f, 0.08f, 1f);
    private static readonly Color TwoColor = new(1f, 0.16f, 0.1f, 1f);
    private static readonly Color OneColor = new(0.72f, 0.3f, 1f, 1f);
    private static readonly Color GoColor = new(0.72f, 0.96f, 1f, 1f);

    [SerializeField] private TMP_Text countdownLabel;
    [SerializeField] private CanvasGroup canvasGroup;
    [SerializeField] private ScreenFade screenFade;
    [SerializeField] private PlayerInput playerInput;
    [SerializeField] private PlayerWeaponController playerWeapon;
    [SerializeField, Min(0f)] private float entryFadeSeconds = 0.75f;
    [SerializeField, Min(0.1f)] private float numberDurationSeconds = 1f;
    [SerializeField, Min(0f)] private float goDurationSeconds = 0.6f;

    private Coroutine countdownRoutine;
    private float previousTimeScale;
    private bool ownsTimePause;
    private bool previousPlayerInputEnabled;
    private bool previousPlayerWeaponEnabled;
    private bool ownsGameplayGate;

    private void OnEnable()
    {
        countdownRoutine = StartCoroutine(RunCountdown());
    }

    private void OnDisable()
    {
        if (countdownRoutine != null)
        {
            StopCoroutine(countdownRoutine);
            countdownRoutine = null;
        }

        RestoreTimeScale();
        RestoreGameplayComponents();
    }

    private IEnumerator RunCountdown()
    {
        RunSession session = RunSessionService.Instance.Session;
        if (session.Phase == RunPhase.NotStarted)
            session.BeginNewRun();

        if (session.Phase != RunPhase.Countdown)
        {
            SetVisible(false);
            countdownRoutine = null;
            enabled = false;
            yield break;
        }

        GateGameplayComponents();
        PauseGameplay();
        SetLabel("3", ThreeColor, false);
        SetVisible(true);

        if (screenFade != null)
            screenFade.FadeOut(entryFadeSeconds);

        if (entryFadeSeconds > 0f)
            yield return new WaitForSecondsRealtime(entryFadeSeconds);

        yield return AnimateLabel(numberDurationSeconds, false);
        yield return ShowForDuration("2", TwoColor, numberDurationSeconds, false);
        yield return ShowForDuration("1", OneColor, numberDurationSeconds, false);

        if (!session.StartRun())
        {
            RestoreTimeScale();
            SetVisible(false);
            enabled = false;
            yield break;
        }

        SetLabel("GO!", GoColor, true);
        RestoreTimeScale();
        RestoreGameplayComponents();

        yield return AnimateLabel(goDurationSeconds, true);

        SetVisible(false);
        countdownRoutine = null;
        enabled = false;
    }

    private IEnumerator ShowForDuration(
        string value,
        Color color,
        float durationSeconds,
        bool isGo)
    {
        SetLabel(value, color, isGo);
        yield return AnimateLabel(durationSeconds, isGo);
    }

    private IEnumerator AnimateLabel(float durationSeconds, bool isGo)
    {
        if (countdownLabel == null || durationSeconds <= 0f)
            yield break;

        RectTransform labelTransform = countdownLabel.rectTransform;
        float elapsed = 0f;
        float startScale = isGo ? 0.78f : 1.28f;
        float endScale = isGo ? 1.08f : 0.94f;

        while (elapsed < durationSeconds)
        {
            float progress = Mathf.Clamp01(elapsed / durationSeconds);
            float eased = 1f - Mathf.Pow(1f - progress, 3f);
            float scale = Mathf.LerpUnclamped(startScale, endScale, eased);

            float fadeIn = Mathf.Clamp01(progress / 0.12f);
            float fadeOut = Mathf.Clamp01((1f - progress) / (isGo ? 0.22f : 0.16f));
            countdownLabel.alpha = Mathf.Min(fadeIn, fadeOut);
            labelTransform.localScale = Vector3.one * scale;

            elapsed += Time.unscaledDeltaTime;
            yield return null;
        }

        countdownLabel.alpha = 0f;
        labelTransform.localScale = Vector3.one;
    }

    private void PauseGameplay()
    {
        if (ownsTimePause)
            return;

        previousTimeScale = Time.timeScale;
        Time.timeScale = 0f;
        ownsTimePause = true;
    }

    private void RestoreTimeScale()
    {
        if (!ownsTimePause)
            return;

        Time.timeScale = previousTimeScale;
        ownsTimePause = false;
    }

    private void GateGameplayComponents()
    {
        if (ownsGameplayGate)
            return;

        if (playerInput != null)
        {
            previousPlayerInputEnabled = playerInput.enabled;
            playerInput.enabled = false;
        }

        if (playerWeapon != null)
        {
            previousPlayerWeaponEnabled = playerWeapon.enabled;
            playerWeapon.enabled = false;
        }

        ownsGameplayGate = true;
    }

    private void RestoreGameplayComponents()
    {
        if (!ownsGameplayGate)
            return;

        if (playerInput != null)
            playerInput.enabled = previousPlayerInputEnabled;

        if (playerWeapon != null)
            playerWeapon.enabled = previousPlayerWeaponEnabled;

        ownsGameplayGate = false;
    }

    private void SetVisible(bool visible)
    {
        if (canvasGroup == null)
            return;

        canvasGroup.alpha = visible ? 1f : 0f;
        canvasGroup.interactable = false;
        canvasGroup.blocksRaycasts = visible;
    }

    private void SetLabel(string value, Color color, bool isGo)
    {
        if (countdownLabel == null)
            return;

        Color topColor = Color.Lerp(color, Color.white, 0.34f);
        Color bottomColor = Color.Lerp(color, Color.black, 0.16f);

        countdownLabel.text = value;
        countdownLabel.color = Color.white;
        countdownLabel.enableVertexGradient = true;
        countdownLabel.colorGradient = new VertexGradient(topColor, topColor, bottomColor, bottomColor);
        countdownLabel.fontStyle = FontStyles.Bold;
        countdownLabel.characterSpacing = isGo ? 8f : 0f;
        countdownLabel.outlineColor = new Color32(0, 0, 0, 230);
        countdownLabel.outlineWidth = 0.17f;
        countdownLabel.alpha = 0f;
        countdownLabel.rectTransform.localScale = Vector3.one;
    }
}
