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
    IPointerUpHandler,
    ISelectHandler,
    IDeselectHandler
{
    private const float HoveredScale = 1.045f;
    private const float SelectedScale = 1.035f;
    private const float PressedScale = 0.975f;
    private const float ResponseSpeed = 18f;

    private Button button;
    [SerializeField] private RectTransform visualTarget;
    [SerializeField] private Color accentColor = Color.white;
    [SerializeField] private bool hasConfiguredAccent;
    private Vector3 restingScale = Vector3.one;
    private bool isPointerInside;
    private bool isPressed;
    private bool isSelected;

    private void Awake()
    {
        button = GetComponent<Button>();

        if (visualTarget == null && button.targetGraphic != null)
            visualTarget = button.targetGraphic.rectTransform;

        CaptureRestingScale();
    }

    public Color AccentColor => accentColor;

    public bool HasConfiguredAccent => hasConfiguredAccent;

    public void Configure(RectTransform target, Color accent)
    {
        visualTarget = target;
        accentColor = new Color(accent.r, accent.g, accent.b, 1f);
        hasConfiguredAccent = true;
        CaptureRestingScale();
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
                : isSelected
                    ? SelectedScale
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
        isSelected = false;

        if (visualTarget != null)
            visualTarget.localScale = restingScale;
    }

    private void CaptureRestingScale()
    {
        if (visualTarget != null)
            restingScale = visualTarget.localScale;
    }

    private void FadeVisualTo(Color targetColor)
    {
        if (button.targetGraphic == null)
            return;

        button.targetGraphic.CrossFadeColor(
            targetColor * button.colors.colorMultiplier,
            button.colors.fadeDuration,
            true,
            true);
    }

    public void OnPointerEnter(PointerEventData _)
    {
        if (TryUsePointerFeedback())
        {
            isPointerInside = true;
            FadeVisualTo(button.colors.highlightedColor);
        }
    }

    public void OnPointerExit(PointerEventData _)
    {
        isPointerInside = false;

        if (button.isActiveAndEnabled && button.IsInteractable())
            FadeVisualTo(button.colors.normalColor);
        else
            RestoreRestingState();
    }

    public void OnPointerDown(PointerEventData _)
    {
        if (TryUsePointerFeedback())
        {
            isPressed = true;
            FadeVisualTo(button.colors.pressedColor);
        }
    }

    public void OnPointerUp(PointerEventData _)
    {
        if (TryUsePointerFeedback())
        {
            isPressed = false;
            FadeVisualTo(isPointerInside
                ? button.colors.highlightedColor
                : button.colors.normalColor);
        }
    }

    public void OnSelect(BaseEventData _)
    {
        if (TryUsePointerFeedback())
        {
            isSelected = true;
            if (!isPointerInside)
                FadeVisualTo(button.colors.normalColor);
        }
    }

    public void OnDeselect(BaseEventData _)
    {
        isSelected = false;
        FadeVisualTo(isPointerInside
            ? button.colors.highlightedColor
            : button.colors.normalColor);
    }
}
