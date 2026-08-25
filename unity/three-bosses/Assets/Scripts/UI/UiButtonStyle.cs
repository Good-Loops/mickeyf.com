using TMPro;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Keeps button feedback on the label instead of tinting a large rectangle
/// over the authored screen artwork.
/// </summary>
public static class UiButtonStyle
{
    public static void Apply(Button button)
    {
        if (button == null)
            return;

        ApplyToGraphic(button, button.GetComponentInChildren<TMP_Text>(true));
    }

    public static void ApplyToGraphic(Button button, Graphic visualTarget)
    {
        if (button == null || visualTarget == null)
            return;

        ButtonHoverFeedback feedback = button.GetComponent<ButtonHoverFeedback>();
        if (feedback == null)
            feedback = button.gameObject.AddComponent<ButtonHoverFeedback>();

        Color serializedAccent = feedback.HasConfiguredAccent
            ? feedback.AccentColor
            : button.colors.highlightedColor;
        Color accent = new(serializedAccent.r, serializedAccent.g, serializedAccent.b, 1f);
        Color normal = new(0.89f, 0.91f, 0.94f, 1f);
        Color focused = Color.Lerp(Color.white, accent, 0.18f);
        Color pressed = Color.Lerp(Color.white, accent, 0.55f);

        Image hitArea = button.GetComponent<Image>();
        if (hitArea != null)
            hitArea.color = Color.clear;

        visualTarget.color = normal;
        visualTarget.raycastTarget = false;
        button.targetGraphic = visualTarget;
        button.transition = Selectable.Transition.ColorTint;

        ColorBlock colors = button.colors;
        colors.normalColor = normal;
        colors.highlightedColor = focused;
        colors.selectedColor = normal;
        colors.pressedColor = pressed;
        colors.disabledColor = new Color(0.46f, 0.46f, 0.5f, 0.62f);
        colors.colorMultiplier = 1f;
        colors.fadeDuration = 0.1f;
        button.colors = colors;

        feedback.Configure(visualTarget.rectTransform, accent);
    }
}
