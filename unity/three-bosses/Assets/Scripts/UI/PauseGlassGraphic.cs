using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Draws the pause UI's lightweight simulated glass without textures, shaders,
/// or additional cameras. Input remains on the parent Button hit area.
/// </summary>
[RequireComponent(typeof(CanvasRenderer))]
public sealed class PauseGlassGraphic : MaskableGraphic
{
    public enum Style { PauseButton, MenuPanel, ActionButton }

    private const int CornerSegments = 8;
    private static readonly Color Pearl = new(0.86f, 0.94f, 0.97f);
    private static readonly Color Slate = new(0.34f, 0.47f, 0.52f);
    private static readonly Color Ink = new(0.025f, 0.04f, 0.055f);

    [SerializeField] private Style controlStyle;

    public Style ControlStyle => controlStyle;

    public void Configure(Style style)
    {
        controlStyle = style;
        raycastTarget = false;
        color = Color.white;
        SetVerticesDirty();
    }

    protected override void OnEnable()
    {
        base.OnEnable();
        raycastTarget = false;
    }

    protected override void OnPopulateMesh(VertexHelper mesh)
    {
        mesh.Clear();
        Rect rect = GetPixelAdjustedRect();
        if (rect.width <= 0f || rect.height <= 0f)
            return;

        float cornerRadius = controlStyle switch
        {
            Style.PauseButton => Mathf.Min(rect.width, rect.height) * 0.48f,
            Style.MenuPanel => 17f,
            _ => 13f,
        };
        float rimWidth = controlStyle == Style.MenuPanel ? 2f : 1.5f;
        float fillOpacity = controlStyle switch
        {
            Style.PauseButton => 0.13f,
            Style.MenuPanel => 0.26f,
            _ => 0.16f,
        };

        Rect shadowRect = Offset(rect, 0f, -2f);
        AddRoundedRing(mesh, shadowRect, cornerRadius, 3f, 0.24f);
        AddRoundedFill(
            mesh,
            rect,
            cornerRadius,
            Tint(Pearl, fillOpacity * 0.34f),
            Tint(Ink, fillOpacity));
        AddRoundedRing(mesh, rect, cornerRadius, rimWidth, 0.62f);

        Rect innerRect = Inset(rect, rimWidth + 2f);
        AddRoundedRing(
            mesh,
            innerRect,
            Mathf.Max(1f, cornerRadius - rimWidth - 2f),
            0.7f,
            0.16f);

        if (controlStyle == Style.MenuPanel)
            AddPanelDetails(mesh, rect, cornerRadius);
        else if (controlStyle == Style.PauseButton)
            AddPauseIcon(mesh, rect.center, Mathf.Min(rect.width, rect.height));
    }

    private void AddPanelDetails(VertexHelper mesh, Rect rect, float radius)
    {
        Color lineColor = Tint(Pearl, 0.24f);
        float inset = radius + 5f;
        float length = 25f;
        float yTop = rect.yMax - 8f;
        float yBottom = rect.yMin + 8f;
        AddLine(mesh, new Vector2(rect.xMin + inset, yTop),
            new Vector2(rect.xMin + inset + length, yTop), 1.1f, lineColor);
        AddLine(mesh, new Vector2(rect.xMax - inset - length, yTop),
            new Vector2(rect.xMax - inset, yTop), 1.1f, lineColor);
        AddLine(mesh, new Vector2(rect.xMin + inset, yBottom),
            new Vector2(rect.xMin + inset + length * 0.55f, yBottom), 0.8f, Tint(Slate, 0.22f));
        AddLine(mesh, new Vector2(rect.xMax - inset - length * 0.55f, yBottom),
            new Vector2(rect.xMax - inset, yBottom), 0.8f, Tint(Slate, 0.22f));
    }

    private void AddPauseIcon(VertexHelper mesh, Vector2 center, float size)
    {
        Color shadow = Tint(Ink, 0.56f);
        Color icon = Tint(Pearl, 0.92f);
        AddBar(mesh, center + new Vector2(-size * 0.105f, -size * 0.02f), size, shadow);
        AddBar(mesh, center + new Vector2(size * 0.105f, -size * 0.02f), size, shadow);
        AddBar(mesh, center + Vector2.left * size * 0.105f, size, icon);
        AddBar(mesh, center + Vector2.right * size * 0.105f, size, icon);
    }

    private static void AddBar(VertexHelper mesh, Vector2 center, float size, Color tint)
    {
        Rect bar = new(
            center.x - size * 0.045f,
            center.y - size * 0.19f,
            size * 0.09f,
            size * 0.38f);
        AddRoundedFill(mesh, bar, size * 0.042f, tint, tint);
    }

    private void AddRoundedRing(
        VertexHelper mesh,
        Rect rect,
        float radius,
        float width,
        float opacity)
    {
        Rect innerRect = Inset(rect, width);
        float innerRadius = Mathf.Max(0f, radius - width);
        int first = mesh.currentVertCount;
        int pointCount = CornerSegments * 4;
        for (int index = 0; index < pointCount; index++)
        {
            Vector2 outer = PerimeterPoint(rect, radius, index);
            Vector2 inner = PerimeterPoint(innerRect, innerRadius, index);
            Color tint = RimTint(outer, rect, opacity);
            mesh.AddVert(outer, tint, Vector2.zero);
            mesh.AddVert(inner, tint, Vector2.zero);
        }

        for (int index = 0; index < pointCount; index++)
        {
            int next = (index + 1) % pointCount;
            int outerA = first + index * 2;
            int innerA = outerA + 1;
            int outerB = first + next * 2;
            int innerB = outerB + 1;
            mesh.AddTriangle(outerA, outerB, innerB);
            mesh.AddTriangle(outerA, innerB, innerA);
        }
    }

    private static void AddRoundedFill(
        VertexHelper mesh,
        Rect rect,
        float radius,
        Color top,
        Color bottom)
    {
        int first = mesh.currentVertCount;
        mesh.AddVert(rect.center, Color.Lerp(bottom, top, 0.5f), Vector2.zero);
        int pointCount = CornerSegments * 4;
        for (int index = 0; index < pointCount; index++)
        {
            Vector2 point = PerimeterPoint(rect, radius, index);
            float vertical = Mathf.InverseLerp(rect.yMin, rect.yMax, point.y);
            mesh.AddVert(point, Color.Lerp(bottom, top, vertical), Vector2.zero);
        }

        for (int index = 0; index < pointCount; index++)
            mesh.AddTriangle(first, first + index + 1, first + (index + 1) % pointCount + 1);
    }

    private Color RimTint(Vector2 point, Rect rect, float opacity)
    {
        float horizontal = Mathf.InverseLerp(rect.xMin, rect.xMax, point.x);
        float vertical = Mathf.InverseLerp(rect.yMin, rect.yMax, point.y);
        float highlight = Mathf.Clamp01(vertical * 0.76f + (1f - horizontal) * 0.24f);
        return Tint(
            Color.Lerp(Slate, Pearl, highlight),
            opacity * Mathf.Lerp(0.38f, 1f, highlight));
    }

    private static Vector2 PerimeterPoint(Rect rect, float radius, int index)
    {
        int corner = index / CornerSegments;
        int step = index % CornerSegments;
        float angle = 180f + corner * 90f + step * 90f / (CornerSegments - 1);
        Vector2 cornerCenter = corner switch
        {
            0 => new Vector2(rect.xMin + radius, rect.yMin + radius),
            1 => new Vector2(rect.xMax - radius, rect.yMin + radius),
            2 => new Vector2(rect.xMax - radius, rect.yMax - radius),
            _ => new Vector2(rect.xMin + radius, rect.yMax - radius),
        };
        float radians = angle * Mathf.Deg2Rad;
        return cornerCenter + new Vector2(Mathf.Cos(radians), Mathf.Sin(radians)) * radius;
    }

    private Color Tint(Color hue, float opacity) =>
        new(hue.r * color.r, hue.g * color.g, hue.b * color.b, opacity * color.a);

    private static Rect Inset(Rect rect, float amount) =>
        new(rect.xMin + amount, rect.yMin + amount,
            Mathf.Max(0f, rect.width - amount * 2f),
            Mathf.Max(0f, rect.height - amount * 2f));

    private static Rect Offset(Rect rect, float x, float y) =>
        new(rect.x + x, rect.y + y, rect.width, rect.height);

    private static void AddLine(
        VertexHelper mesh,
        Vector2 start,
        Vector2 end,
        float width,
        Color tint)
    {
        Vector2 direction = end - start;
        Vector2 normal = new Vector2(-direction.y, direction.x).normalized * width * 0.5f;
        int first = mesh.currentVertCount;
        mesh.AddVert(start - normal, tint, Vector2.zero);
        mesh.AddVert(start + normal, tint, Vector2.zero);
        mesh.AddVert(end + normal, tint, Vector2.zero);
        mesh.AddVert(end - normal, tint, Vector2.zero);
        mesh.AddTriangle(first, first + 1, first + 2);
        mesh.AddTriangle(first, first + 2, first + 3);
    }
}
