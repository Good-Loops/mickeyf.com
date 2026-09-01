using UnityEngine;

/// <summary>
/// Shows the gameplay touch HUD only when the browser or native host permits it.
/// </summary>
public sealed class TouchControlsVisibility : MonoBehaviour
{
    [SerializeField] private GameObject controlsRoot;

    private RunSessionService runSessionService;

    private void OnEnable()
    {
        runSessionService = RunSessionService.Instance;
        runSessionService.TouchControlsAvailabilityChanged += RefreshVisibility;
        RefreshVisibility();
    }

    private void OnDisable()
    {
        if (runSessionService != null)
            runSessionService.TouchControlsAvailabilityChanged -= RefreshVisibility;
        runSessionService = null;

        if (controlsRoot != null)
            controlsRoot.SetActive(false);
    }

    public void RefreshVisibility()
    {
        if (controlsRoot != null)
            controlsRoot.SetActive(
                runSessionService != null
                && runSessionService.TouchControlsEnabled);
    }
}
