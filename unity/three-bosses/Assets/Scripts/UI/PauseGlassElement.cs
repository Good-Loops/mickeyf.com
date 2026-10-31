using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

/// <summary>Texture-free glass matching the former pause graphic; the surrounding Button owns input.</summary>
public sealed class PauseGlassElement : VisualElement
{
    public enum GlassStyle { PauseButton, MenuPanel, ActionButton }

    private const int CornerSegments = 8;
    private const int PerimeterCount = CornerSegments * 4;
    private static readonly Color Pearl = new(0.86f, 0.94f, 0.97f);
    private static readonly Color Slate = new(0.34f, 0.47f, 0.52f);
    private static readonly Color Ink = new(0.025f, 0.04f, 0.055f);
    private readonly List<Vertex> vertices = new(256);
    private readonly List<ushort> indices = new(768);
    private readonly GlassStyle glassStyle;
    private bool hovered;
    private bool focused;
    private bool pressed;

    public static void Install(VisualElement host, string name, GlassStyle style, Button button = null)
    {
        if (host.Q<PauseGlassElement>(name) == null)
            host.Insert(0, new PauseGlassElement(style, button) { name = name });
    }

    private PauseGlassElement(GlassStyle glassStyle, Button button)
    {
        this.glassStyle = glassStyle;
        pickingMode = PickingMode.Ignore;
        AddToClassList("pause-glass");
        style.position = Position.Absolute;
        float horizontalInset = glassStyle == GlassStyle.ActionButton ? 10f : glassStyle == GlassStyle.PauseButton ? 3f : 0f;
        float verticalInset = glassStyle == GlassStyle.MenuPanel ? 0f : 3f;
        style.left = style.right = horizontalInset;
        style.top = style.bottom = verticalInset;
        generateVisualContent += DrawGlass;
        if (button == null)
            return;

        button.RegisterCallback<PointerEnterEvent>(_ => { hovered = true; MarkDirtyRepaint(); });
        button.RegisterCallback<PointerLeaveEvent>(_ => { hovered = false; MarkDirtyRepaint(); });
        button.RegisterCallback<PointerDownEvent>(evt =>
        {
            if (evt.button == 0) { pressed = true; MarkDirtyRepaint(); }
        }, TrickleDown.TrickleDown);
        button.RegisterCallback<PointerUpEvent>(_ => { pressed = false; MarkDirtyRepaint(); }, TrickleDown.TrickleDown);
        button.RegisterCallback<PointerCancelEvent>(_ => { pressed = false; MarkDirtyRepaint(); });
        button.RegisterCallback<PointerCaptureOutEvent>(_ => { pressed = false; MarkDirtyRepaint(); });
        button.RegisterCallback<FocusEvent>(_ => { focused = true; MarkDirtyRepaint(); });
        button.RegisterCallback<BlurEvent>(_ => { focused = false; MarkDirtyRepaint(); });
        button.RegisterCallback<DetachFromPanelEvent>(_ =>
        {
            hovered = focused = pressed = false;
            MarkDirtyRepaint();
        });
    }

    private void DrawGlass(MeshGenerationContext context)
    {
        Rect rect = contentRect;
        if (rect.width <= 0f || rect.height <= 0f)
            return;
        vertices.Clear();
        indices.Clear();
        float radius = glassStyle == GlassStyle.PauseButton ? Mathf.Min(rect.width, rect.height) * 0.48f
            : glassStyle == GlassStyle.MenuPanel ? 17f : 13f;
        float rimWidth = glassStyle == GlassStyle.MenuPanel ? 2f : 1.5f;
        float opacity = glassStyle == GlassStyle.PauseButton ? 0.13f : glassStyle == GlassStyle.MenuPanel ? 0.26f : 0.16f;
        bool activePress = pressed && hovered;
        float highlight = activePress ? 1f : hovered ? 0.85f : focused ? 0.35f : 0f;
        opacity += activePress ? 0.12f : highlight * 0.075f;

        AddRing(new Rect(rect.x, rect.y + 2f, rect.width, rect.height), radius, 3f, 0.24f);
        AddFill(rect, radius, WithAlpha(Pearl, opacity * 0.34f), WithAlpha(Ink, opacity));
        AddRing(rect, radius, rimWidth, Mathf.Lerp(0.62f, 1f, highlight));
        AddRing(Inset(rect, rimWidth + 2f), Mathf.Max(1f, radius - rimWidth - 2f), 0.7f,
            Mathf.Lerp(0.16f, 0.4f, highlight));
        if (glassStyle == GlassStyle.MenuPanel)
            AddPanelDetails(rect, radius);

        MeshWriteData mesh = context.Allocate(vertices.Count, indices.Count);
        foreach (Vertex vertex in vertices) mesh.SetNextVertex(vertex);
        foreach (ushort index in indices) mesh.SetNextIndex(index);
    }

    private void AddPanelDetails(Rect rect, float radius)
    {
        float inset = radius + 5f;
        AddLine(new Vector2(rect.xMin + inset, rect.yMin + 8f), new Vector2(rect.xMin + inset + 25f, rect.yMin + 8f),
            1.1f, WithAlpha(Pearl, 0.24f));
        AddLine(new Vector2(rect.xMax - inset - 25f, rect.yMin + 8f), new Vector2(rect.xMax - inset, rect.yMin + 8f),
            1.1f, WithAlpha(Pearl, 0.24f));
        AddLine(new Vector2(rect.xMin + inset, rect.yMax - 8f), new Vector2(rect.xMin + inset + 13.75f, rect.yMax - 8f),
            0.8f, WithAlpha(Slate, 0.22f));
        AddLine(new Vector2(rect.xMax - inset - 13.75f, rect.yMax - 8f), new Vector2(rect.xMax - inset, rect.yMax - 8f),
            0.8f, WithAlpha(Slate, 0.22f));
    }

    private void AddRing(Rect rect, float radius, float width, float opacity)
    {
        Rect inner = Inset(rect, width);
        int first = vertices.Count;
        for (int index = 0; index < PerimeterCount; index++)
        {
            Vector2 outerPoint = PerimeterPoint(rect, radius, index);
            float horizontal = Mathf.InverseLerp(rect.xMin, rect.xMax, outerPoint.x);
            float vertical = 1f - Mathf.InverseLerp(rect.yMin, rect.yMax, outerPoint.y);
            float highlight = Mathf.Clamp01(vertical * 0.76f + (1f - horizontal) * 0.24f);
            Color tint = WithAlpha(Color.Lerp(Slate, Pearl, highlight), opacity * Mathf.Lerp(0.38f, 1f, highlight));
            AddVertex(outerPoint, tint);
            AddVertex(PerimeterPoint(inner, Mathf.Max(0f, radius - width), index), tint);
        }
        for (int index = 0; index < PerimeterCount; index++)
        {
            int a = first + index * 2;
            int b = first + (index + 1) % PerimeterCount * 2;
            AddTriangle(a, b, b + 1);
            AddTriangle(a, b + 1, a + 1);
        }
    }

    private void AddFill(Rect rect, float radius, Color top, Color bottom)
    {
        int first = vertices.Count;
        AddVertex(rect.center, Color.Lerp(top, bottom, 0.5f));
        for (int index = 0; index < PerimeterCount; index++)
        {
            Vector2 point = PerimeterPoint(rect, radius, index);
            AddVertex(point, Color.Lerp(top, bottom, Mathf.InverseLerp(rect.yMin, rect.yMax, point.y)));
        }
        for (int index = 0; index < PerimeterCount; index++)
            AddTriangle(first, first + index + 1, first + (index + 1) % PerimeterCount + 1);
    }

    private void AddLine(Vector2 start, Vector2 end, float width, Color tint)
    {
        Vector2 direction = end - start;
        Vector2 normal = new Vector2(-direction.y, direction.x).normalized * width * 0.5f;
        int first = vertices.Count;
        AddVertex(start - normal, tint);
        AddVertex(start + normal, tint);
        AddVertex(end + normal, tint);
        AddVertex(end - normal, tint);
        // Toolkit triangles are clockwise in its top-left-origin coordinate system.
        AddTriangle(first, first + 2, first + 1);
        AddTriangle(first, first + 3, first + 2);
    }

    private void AddVertex(Vector2 point, Color tint) => vertices.Add(new Vertex
    {
        position = new Vector3(point.x, point.y, Vertex.nearZ), tint = tint, uv = Vector2.zero
    });

    private void AddTriangle(int a, int b, int c)
    {
        indices.Add((ushort)a);
        indices.Add((ushort)b);
        indices.Add((ushort)c);
    }

    private static Vector2 PerimeterPoint(Rect rect, float radius, int index)
    {
        radius = Mathf.Min(radius, Mathf.Min(rect.width, rect.height) * 0.5f);
        int corner = index / CornerSegments;
        float angle = (180f + corner * 90f + index % CornerSegments * 90f / (CornerSegments - 1)) * Mathf.Deg2Rad;
        Vector2 center = corner switch
        {
            0 => new Vector2(rect.xMin + radius, rect.yMin + radius),
            1 => new Vector2(rect.xMax - radius, rect.yMin + radius),
            2 => new Vector2(rect.xMax - radius, rect.yMax - radius),
            _ => new Vector2(rect.xMin + radius, rect.yMax - radius)
        };
        return center + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius;
    }

    private static Color WithAlpha(Color color, float alpha) => new(color.r, color.g, color.b, alpha);
    private static Rect Inset(Rect rect, float amount) => new(rect.x + amount, rect.y + amount,
        Mathf.Max(0f, rect.width - amount * 2f), Mathf.Max(0f, rect.height - amount * 2f));
}
