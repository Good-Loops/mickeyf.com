using System.Collections;
using ThreeBosses.Run;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

[DefaultExecutionOrder(-1100)]
public sealed class RunCountdownController : MonoBehaviour
{
    private const float DimmerAlpha = 0.56f;
    private const float FirstNumberHoldSeconds = 0.2f;

    private static readonly Color ThreeTopColor = new(0.843f, 1f, 0.412f, 1f);
    private static readonly Color ThreeBottomColor = new(0.51f, 0.788f, 0f, 1f);
    private static readonly Color TwoTopColor = new(1f, 0.541f, 0.467f, 1f);
    private static readonly Color TwoBottomColor = new(0.788f, 0.114f, 0.078f, 1f);
    private static readonly Color OneTopColor = new(0.867f, 0.627f, 1f, 1f);
    private static readonly Color OneBottomColor = new(0.486f, 0.173f, 0.831f, 1f);
    private static readonly Color GoTopColor = new(0.961f, 0.992f, 1f, 1f);
    private static readonly Color GoBottomColor = new(0.345f, 0.851f, 1f, 1f);

    [SerializeField] private TMP_Text countdownLabel;
    [SerializeField] private CanvasGroup canvasGroup;
    [SerializeField] private Image dimmer;
    [SerializeField] private ScreenFade screenFade;
    [SerializeField] private PlayerInput playerInput;
    [SerializeField] private PlayerWeaponController playerWeapon;
    [SerializeField] private BossController bossController;
    [SerializeField, Min(0f)] private float entryFadeSeconds = 0.75f;
    [SerializeField, Min(0.1f)] private float numberDurationSeconds = 1f;
    [SerializeField, Min(0f)] private float goDurationSeconds = 0.6f;

    private Coroutine countdownRoutine;
    private float previousTimeScale;
    private bool ownsTimePause;
    private bool previousPlayerInputEnabled;
    private bool previousPlayerWeaponEnabled;
    private bool previousBossControllerEnabled;
    private bool ownsGameplayGate;

    private void Awake()
    {
        PrepareCountdown();
    }

    private void Start()
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
        SetVisible(false);
    }

    private IEnumerator RunCountdown()
    {
        RunSession session = RunSessionService.Instance.Session;
        if (!PrepareCountdown())
        {
            SetVisible(false);
            countdownRoutine = null;
            enabled = false;
            yield break;
        }

        if (screenFade != null)
            screenFade.FadeOut(entryFadeSeconds);

        // Scene startup can produce an unusually large first unscaled delta.
        // Give the first numeral one rendered frame and a guaranteed readable
        // hold so loading work cannot make the countdown appear to start at 2.
        yield return null;
        SetLabel("3", ThreeTopColor, ThreeBottomColor, false);
        countdownLabel.alpha = 1f;
        countdownLabel.rectTransform.localScale = Vector3.one * 1.14f;

        float firstNumberHoldSeconds = Mathf.Min(
            FirstNumberHoldSeconds,
            numberDurationSeconds);
        if (firstNumberHoldSeconds > 0f)
            yield return new WaitForSecondsRealtime(firstNumberHoldSeconds);

        yield return AnimateLabel(
            numberDurationSeconds - firstNumberHoldSeconds,
            false,
            startsFullyVisible: true);
        yield return ShowForDuration(
            "2",
            TwoTopColor,
            TwoBottomColor,
            numberDurationSeconds,
            false);
        yield return ShowForDuration(
            "1",
            OneTopColor,
            OneBottomColor,
            numberDurationSeconds,
            false);

        SetLabel("GO!", GoTopColor, GoBottomColor, true);

        if (!session.StartRun())
        {
            RestoreTimeScale();
            SetVisible(false);
            enabled = false;
            yield break;
        }

        RestoreTimeScale();
        RestoreGameplayComponents();

        yield return AnimateLabel(goDurationSeconds, true);

        SetVisible(false);
        countdownRoutine = null;
        enabled = false;
    }

    private bool PrepareCountdown()
    {
        RunSession session = RunSessionService.Instance.Session;
        if (session.Phase == RunPhase.NotStarted)
            session.BeginNewRun();

        if (session.Phase != RunPhase.Countdown)
            return false;

        GateGameplayComponents();
        PauseGameplay();
        SetLabel("3", ThreeTopColor, ThreeBottomColor, false);
        SetVisible(true);
        return true;
    }

    private IEnumerator ShowForDuration(
        string value,
        Color topColor,
        Color bottomColor,
        float durationSeconds,
        bool isGo)
    {
        SetLabel(value, topColor, bottomColor, isGo);
        yield return AnimateLabel(durationSeconds, isGo);
    }

    private IEnumerator AnimateLabel(
        float durationSeconds,
        bool isGo,
        bool startsFullyVisible = false)
    {
        if (countdownLabel == null || durationSeconds <= 0f)
            yield break;

        RectTransform labelTransform = countdownLabel.rectTransform;
        float elapsed = 0f;

        while (elapsed < durationSeconds)
        {
            float progress = Mathf.Clamp01(elapsed / durationSeconds);
            float scale;
            float fadeIn;
            float fadeOut;

            if (isGo)
            {
                if (progress < 0.267f)
                {
                    float rise = EaseOutCubic(progress / 0.267f);
                    scale = Mathf.LerpUnclamped(0.86f, 1.06f, rise);
                }
                else if (progress < 0.6f)
                {
                    float settle = Mathf.InverseLerp(0.267f, 0.6f, progress);
                    scale = Mathf.LerpUnclamped(1.06f, 1f, Mathf.SmoothStep(0f, 1f, settle));
                }
                else
                {
                    scale = 1f;
                }

                fadeIn = Mathf.Lerp(0.18f, 1f, Mathf.Clamp01(progress / 0.267f));
                fadeOut = Mathf.Clamp01((1f - progress) / 0.333f);

                float dimmerFade = Mathf.SmoothStep(
                    0f,
                    1f,
                    Mathf.Clamp01(progress / 0.633f));
                SetDimmerAlpha(Mathf.Lerp(DimmerAlpha, 0f, dimmerFade));
            }
            else
            {
                scale = Mathf.LerpUnclamped(1.14f, 0.96f, EaseOutCubic(progress));
                fadeIn = startsFullyVisible
                    ? 1f
                    : Mathf.Clamp01(progress / 0.14f);
                fadeOut = Mathf.Clamp01((1f - progress) / 0.18f);
            }

            countdownLabel.alpha = Mathf.Min(fadeIn, fadeOut);
            labelTransform.localScale = Vector3.one * scale;

            elapsed += Time.unscaledDeltaTime;
            yield return null;
        }

        countdownLabel.alpha = 0f;
        labelTransform.localScale = Vector3.one;

        if (isGo)
            SetDimmerAlpha(0f);
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

        if (bossController == null)
            bossController = FindFirstObjectByType<BossController>();

        if (bossController != null)
        {
            previousBossControllerEnabled = bossController.enabled;
            bossController.enabled = false;
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

        if (bossController != null)
            bossController.enabled = previousBossControllerEnabled;

        ownsGameplayGate = false;
    }

    private void SetVisible(bool visible)
    {
        if (canvasGroup == null)
            return;

        canvasGroup.alpha = visible ? 1f : 0f;
        canvasGroup.interactable = false;
        canvasGroup.blocksRaycasts = visible;

        if (visible)
            SetDimmerAlpha(DimmerAlpha);
    }

    private void SetLabel(
        string value,
        Color topColor,
        Color bottomColor,
        bool isGo)
    {
        if (countdownLabel == null)
            return;

        countdownLabel.text = value;
        countdownLabel.color = Color.white;
        countdownLabel.enableVertexGradient = true;
        countdownLabel.colorGradient = new VertexGradient(topColor, topColor, bottomColor, bottomColor);
        countdownLabel.enableAutoSizing = false;
        countdownLabel.fontSize = isGo ? 190f : 220f;
        countdownLabel.fontStyle = FontStyles.Bold;
        countdownLabel.characterSpacing = isGo ? 8f : 0f;
        countdownLabel.outlineColor = new Color32(5, 8, 13, 242);
        countdownLabel.outlineWidth = 0.12f;
        countdownLabel.alpha = isGo ? 0.18f : 0f;
        countdownLabel.rectTransform.localScale = Vector3.one * (isGo ? 0.86f : 1.14f);
    }

    private void SetDimmerAlpha(float alpha)
    {
        if (dimmer == null)
            return;

        Color color = dimmer.color;
        color.a = Mathf.Clamp01(alpha);
        dimmer.color = color;
    }

    private static float EaseOutCubic(float value)
    {
        float clamped = Mathf.Clamp01(value);
        return 1f - Mathf.Pow(1f - clamped, 3f);
    }
}
