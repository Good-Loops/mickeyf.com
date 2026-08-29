using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Draws a scalable speaker icon whose waves or mute cross reflect the saved
/// audio setting without relying on a font glyph or external image asset.
/// </summary>
[RequireComponent(typeof(CanvasRenderer))]
public sealed class AudioToggleIcon : MaskableGraphic
{
    private const int ArcSegments = 8;

    [SerializeField] private bool audioEnabled = true;

    public bool IsAudioEnabled => audioEnabled;

    public void SetAudioEnabled(bool enabled)
    {
        if (audioEnabled == enabled)
            return;

        audioEnabled = enabled;
        SetVerticesDirty();
    }

    protected override void OnPopulateMesh(VertexHelper vertexHelper)
    {
        vertexHelper.Clear();

        Rect pixelRect = GetPixelAdjustedRect();
        float size = Mathf.Min(pixelRect.width, pixelRect.height);
        if (size <= 0f)
            return;

        // Center the complete silhouette rather than only its drawing origin.
        // A small upward optical correction keeps the downscaled WebGL icon
        // from landing a full pixel below the button's visual center.
        float horizontalCenterOffset = audioEnabled ? -0.03f : -0.015f;
#if UNITY_WEBGL && !UNITY_EDITOR
        // Chrome's downscaled WebGL canvas gives the right-hand wave strokes
        // more visual weight than the native Editor render.
        horizontalCenterOffset -= 0.135f;
#endif
        const float verticalCenterOffset = 0.055f;
        Vector2 center = pixelRect.center + new Vector2(
            horizontalCenterOffset * size,
            verticalCenterOffset * size);
        float stroke = Mathf.Max(1.5f, size * 0.075f);
        Color32 vertexColor = color;

        AddRect(
            vertexHelper,
            center + new Vector2(-0.39f * size, -0.16f * size),
            center + new Vector2(-0.22f * size, 0.16f * size),
            vertexColor);
        AddQuad(
            vertexHelper,
            center + new Vector2(-0.22f * size, -0.16f * size),
            center + new Vector2(0.02f * size, -0.33f * size),
            center + new Vector2(0.02f * size, 0.33f * size),
            center + new Vector2(-0.22f * size, 0.16f * size),
            vertexColor);

        if (audioEnabled)
        {
            AddArc(vertexHelper, center, size * 0.27f, stroke, vertexColor);
            AddArc(vertexHelper, center, size * 0.45f, stroke, vertexColor);
        }
        else
        {
            AddLine(
                vertexHelper,
                center + new Vector2(0.12f * size, 0.25f * size),
                center + new Vector2(0.42f * size, -0.25f * size),
                stroke * 1.15f,
                vertexColor);
            AddLine(
                vertexHelper,
                center + new Vector2(0.12f * size, -0.25f * size),
                center + new Vector2(0.42f * size, 0.25f * size),
                stroke * 1.15f,
                vertexColor);
        }
    }

    private static void AddArc(
        VertexHelper vertexHelper,
        Vector2 center,
        float radius,
        float thickness,
        Color32 color)
    {
        const float startAngle = -55f;
        const float endAngle = 55f;
        Vector2 previous = ArcPoint(center, radius, startAngle);

        for (int segment = 1; segment <= ArcSegments; segment++)
        {
            float progress = segment / (float)ArcSegments;
            Vector2 current = ArcPoint(
                center,
                radius,
                Mathf.Lerp(startAngle, endAngle, progress));
            AddLine(vertexHelper, previous, current, thickness, color);
            previous = current;
        }
    }

    private static Vector2 ArcPoint(Vector2 center, float radius, float angleDegrees)
    {
        float radians = angleDegrees * Mathf.Deg2Rad;
        return center + new Vector2(Mathf.Cos(radians), Mathf.Sin(radians)) * radius;
    }

    private static void AddLine(
        VertexHelper vertexHelper,
        Vector2 start,
        Vector2 end,
        float thickness,
        Color32 color)
    {
        Vector2 direction = end - start;
        if (direction.sqrMagnitude <= Mathf.Epsilon)
            return;

        Vector2 perpendicular = new Vector2(-direction.y, direction.x).normalized * (thickness * 0.5f);
        AddQuad(
            vertexHelper,
            start - perpendicular,
            end - perpendicular,
            end + perpendicular,
            start + perpendicular,
            color);
    }

    private static void AddRect(
        VertexHelper vertexHelper,
        Vector2 min,
        Vector2 max,
        Color32 color)
    {
        AddQuad(
            vertexHelper,
            new Vector2(min.x, min.y),
            new Vector2(max.x, min.y),
            new Vector2(max.x, max.y),
            new Vector2(min.x, max.y),
            color);
    }

    private static void AddQuad(
        VertexHelper vertexHelper,
        Vector2 bottomLeft,
        Vector2 bottomRight,
        Vector2 topRight,
        Vector2 topLeft,
        Color32 color)
    {
        int startIndex = vertexHelper.currentVertCount;
        vertexHelper.AddVert(bottomLeft, color, Vector2.zero);
        vertexHelper.AddVert(bottomRight, color, Vector2.zero);
        vertexHelper.AddVert(topRight, color, Vector2.zero);
        vertexHelper.AddVert(topLeft, color, Vector2.zero);
        vertexHelper.AddTriangle(startIndex, startIndex + 1, startIndex + 2);
        vertexHelper.AddTriangle(startIndex, startIndex + 2, startIndex + 3);
    }
}
