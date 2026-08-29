using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Keeps the gameplay touch HUD off keyboard-only devices while allowing it
/// to appear whenever Unity detects a real touchscreen.
/// </summary>
public sealed class TouchControlsVisibility : MonoBehaviour
{
    [SerializeField] private GameObject controlsRoot;

    public bool IsTouchscreenPresent => Touchscreen.current != null;

    private void OnEnable()
    {
        InputSystem.onDeviceChange += OnInputDeviceChanged;
        RefreshVisibility();
    }

    private void OnDisable()
    {
        InputSystem.onDeviceChange -= OnInputDeviceChanged;
    }

    public void RefreshVisibility()
    {
        if (controlsRoot != null)
            controlsRoot.SetActive(IsTouchscreenPresent);
    }

    private void OnInputDeviceChanged(InputDevice device, InputDeviceChange change)
    {
        if (device is Touchscreen)
            RefreshVisibility();
    }
}
