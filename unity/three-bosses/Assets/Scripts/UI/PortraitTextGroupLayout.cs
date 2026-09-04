using System;
using TMPro;
using UnityEngine;

/// <summary>
/// Centers selected outcome-screen text when the browser host reports a
/// portrait mobile viewport, while preserving the authored desktop layout.
/// </summary>
[DisallowMultipleComponent]
public sealed class PortraitTextGroupLayout : MonoBehaviour
{
    [SerializeField] private TMP_Text[] textTargets = Array.Empty<TMP_Text>();
    [SerializeField] private Vector2[] portraitPositions = Array.Empty<Vector2>();
    [SerializeField] private Vector2[] portraitSizes = Array.Empty<Vector2>();

    private TextLayoutSnapshot[] desktopLayouts = Array.Empty<TextLayoutSnapshot>();
    private RunSessionService runSessionService;

    private void OnEnable()
    {
        if (!Application.isPlaying)
            return;

        CaptureDesktopLayouts();
        runSessionService = RunSessionService.Instance;
        runSessionService.PortraitUiLayoutChanged += RefreshLayout;
        RefreshLayout();
    }

    private void OnDisable()
    {
        if (!Application.isPlaying)
            return;

        if (runSessionService != null)
            runSessionService.PortraitUiLayoutChanged -= RefreshLayout;

        RestoreDesktopLayouts();
        runSessionService = null;
    }

    private void RefreshLayout()
    {
        if (runSessionService == null || !runSessionService.UsePortraitUiLayout)
        {
            RestoreDesktopLayouts();
            return;
        }

        for (int index = 0; index < desktopLayouts.Length; index++)
        {
            TextLayoutSnapshot layout = desktopLayouts[index];
            if (layout.Text == null)
                continue;

            RectTransform rectTransform = layout.Text.rectTransform;
            rectTransform.anchorMin = WithCenteredX(layout.AnchorMin);
            rectTransform.anchorMax = WithCenteredX(layout.AnchorMax);
            rectTransform.pivot = WithCenteredX(layout.Pivot);
            rectTransform.anchoredPosition = index < portraitPositions.Length
                ? portraitPositions[index]
                : new Vector2(0f, layout.AnchoredPosition.y);
            rectTransform.sizeDelta = index < portraitSizes.Length
                ? portraitSizes[index]
                : layout.SizeDelta;
            layout.Text.alignment = TextAlignmentOptions.Center;
        }
    }

    private void CaptureDesktopLayouts()
    {
        desktopLayouts = new TextLayoutSnapshot[textTargets.Length];
        for (int index = 0; index < textTargets.Length; index++)
        {
            TMP_Text text = textTargets[index];
            if (text == null)
                continue;

            RectTransform rectTransform = text.rectTransform;
            desktopLayouts[index] = new TextLayoutSnapshot(
                text,
                rectTransform.anchorMin,
                rectTransform.anchorMax,
                rectTransform.pivot,
                rectTransform.anchoredPosition,
                rectTransform.sizeDelta,
                text.alignment);
        }
    }

    private void RestoreDesktopLayouts()
    {
        for (int index = 0; index < desktopLayouts.Length; index++)
        {
            TextLayoutSnapshot layout = desktopLayouts[index];
            if (layout.Text == null)
                continue;

            RectTransform rectTransform = layout.Text.rectTransform;
            rectTransform.anchorMin = layout.AnchorMin;
            rectTransform.anchorMax = layout.AnchorMax;
            rectTransform.pivot = layout.Pivot;
            rectTransform.anchoredPosition = layout.AnchoredPosition;
            rectTransform.sizeDelta = layout.SizeDelta;
            layout.Text.alignment = layout.Alignment;
        }
    }

    private static Vector2 WithCenteredX(Vector2 value)
    {
        value.x = 0.5f;
        return value;
    }

    private readonly struct TextLayoutSnapshot
    {
        public TextLayoutSnapshot(
            TMP_Text text,
            Vector2 anchorMin,
            Vector2 anchorMax,
            Vector2 pivot,
            Vector2 anchoredPosition,
            Vector2 sizeDelta,
            TextAlignmentOptions alignment)
        {
            Text = text;
            AnchorMin = anchorMin;
            AnchorMax = anchorMax;
            Pivot = pivot;
            AnchoredPosition = anchoredPosition;
            SizeDelta = sizeDelta;
            Alignment = alignment;
        }

        public TMP_Text Text { get; }
        public Vector2 AnchorMin { get; }
        public Vector2 AnchorMax { get; }
        public Vector2 Pivot { get; }
        public Vector2 AnchoredPosition { get; }
        public Vector2 SizeDelta { get; }
        public TextAlignmentOptions Alignment { get; }
    }
}
