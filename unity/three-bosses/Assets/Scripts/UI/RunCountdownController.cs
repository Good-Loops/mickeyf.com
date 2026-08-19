using System.Collections;
using ThreeBosses.Run;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;

public sealed class RunCountdownController : MonoBehaviour
{
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
        SetVisible(true);

        if (screenFade != null)
            screenFade.FadeOut(entryFadeSeconds);

        if (entryFadeSeconds > 0f)
            yield return new WaitForSecondsRealtime(entryFadeSeconds);

        yield return ShowForDuration("3", numberDurationSeconds);
        yield return ShowForDuration("2", numberDurationSeconds);
        yield return ShowForDuration("1", numberDurationSeconds);

        if (!session.StartRun())
        {
            RestoreTimeScale();
            SetVisible(false);
            enabled = false;
            yield break;
        }

        SetLabel("GO!");
        RestoreTimeScale();
        RestoreGameplayComponents();

        if (goDurationSeconds > 0f)
            yield return new WaitForSecondsRealtime(goDurationSeconds);

        SetVisible(false);
        countdownRoutine = null;
        enabled = false;
    }

    private IEnumerator ShowForDuration(string value, float durationSeconds)
    {
        SetLabel(value);

        if (durationSeconds > 0f)
            yield return new WaitForSecondsRealtime(durationSeconds);
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

    private void SetLabel(string value)
    {
        if (countdownLabel != null)
            countdownLabel.text = value;
    }
}
