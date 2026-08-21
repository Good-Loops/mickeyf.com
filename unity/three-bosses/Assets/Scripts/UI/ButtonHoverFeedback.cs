using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

/// <summary>
/// Adds a restrained scale response to UI buttons without obscuring the
/// underlying screen artwork.
/// </summary>
[RequireComponent(typeof(Button))]
public sealed class ButtonHoverFeedback : MonoBehaviour,
    IPointerEnterHandler,
    IPointerExitHandler,
    IPointerDownHandler,
    IPointerUpHandler
{
    private const float HoveredScale = 1.045f;
    private const float PressedScale = 0.975f;
    private const float ResponseSpeed = 18f;

    private Button button;
    private RectTransform visualTarget;
    private Vector3 restingScale = Vector3.one;
    private bool isPointerInside;
    private bool isPressed;

    private void Awake()
    {
        button = GetComponent<Button>();
    }

    public void Configure(RectTransform target)
    {
        visualTarget = target;
        if (visualTarget != null)
            restingScale = visualTarget.localScale;
    }

    private void Update()
    {
        if (!TryUsePointerFeedback())
            return;

        if (visualTarget == null)
            return;

        float multiplier = isPressed
            ? PressedScale
            : isPointerInside
                ? HoveredScale
                : 1f;

        Vector3 targetScale = restingScale * multiplier;
        float blend = 1f - Mathf.Exp(-ResponseSpeed * Time.unscaledDeltaTime);
        visualTarget.localScale = Vector3.Lerp(visualTarget.localScale, targetScale, blend);
    }

    private void OnDisable()
    {
        RestoreRestingState();
    }

    private bool TryUsePointerFeedback()
    {
        if (button.isActiveAndEnabled && button.IsInteractable())
            return true;

        RestoreRestingState();
        return false;
    }

    private void RestoreRestingState()
    {
        isPointerInside = false;
        isPressed = false;

        if (visualTarget != null)
            visualTarget.localScale = restingScale;
    }

    public void OnPointerEnter(PointerEventData _)
    {
        if (TryUsePointerFeedback())
            isPointerInside = true;
    }

    public void OnPointerExit(PointerEventData _)
    {
        isPointerInside = false;

        if (!button.isActiveAndEnabled || !button.IsInteractable())
            RestoreRestingState();
    }

    public void OnPointerDown(PointerEventData _)
    {
        if (TryUsePointerFeedback())
            isPressed = true;
    }

    public void OnPointerUp(PointerEventData _)
    {
        if (TryUsePointerFeedback())
            isPressed = false;
    }
}
