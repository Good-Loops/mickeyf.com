using TMPro;
using UnityEngine;

/// <summary>
/// Displays the persistent run clock without owning or mutating run state.
/// </summary>
[DisallowMultipleComponent]
[RequireComponent(typeof(TextMeshProUGUI))]
public sealed class RunTimerDisplay : MonoBehaviour
{
    [SerializeField] private TMP_Text timerLabel;

    private void Awake()
    {
        ResolveLabel();
        Refresh();
    }

    private void OnEnable()
    {
        ResolveLabel();
        Refresh();
    }

    private void Update()
    {
        Refresh();
    }

    private void ResolveLabel()
    {
        if (timerLabel == null)
            timerLabel = GetComponent<TMP_Text>();

        if (timerLabel != null)
            return;

        Debug.LogError("RunTimerDisplay requires a TMP text label.", this);
        enabled = false;
    }

    private void Refresh()
    {
        if (timerLabel == null)
            return;

        timerLabel.SetText(
            RunUiFormatter.FormatTime(RunSessionService.Instance.Session.ElapsedSeconds));
    }
}
