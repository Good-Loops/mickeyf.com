using UnityEngine;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.OnScreen;
using UnityEngine.UI;

/// <summary>
/// Lightweight glass and vector icons for the touch HUD. The parent keeps the
/// existing input hit area; this graphic never participates in raycasting.
/// </summary>
[RequireComponent(typeof(CanvasRenderer))]
public sealed class TouchControlGraphic : MaskableGraphic
{
    public enum Style { JoystickBase, JoystickKnob, Jump, Dash, Fire }

    private const int CircleSegments = 48;
    private static readonly Color Pearl = new(0.86f, 0.94f, 0.97f);
    private static readonly Color Slate = new(0.34f, 0.47f, 0.52f);
    private static readonly Color Ink = new(0.025f, 0.04f, 0.055f);

    [SerializeField] private Style controlStyle;
    [SerializeField] private OnScreenControl inputSource;
    private float pressAmount;

    public Style ControlStyle => controlStyle;
    public OnScreenControl InputSource => inputSource;
    public bool IsPressed { get; private set; }

    public void Configure(Style style, OnScreenControl source)
    {
        controlStyle = style;
        inputSource = source;
        raycastTarget = false;
        color = Color.white;
        SetVerticesDirty();
    }

    protected override void OnEnable()
    {
        base.OnEnable();
        raycastTarget = false;
    }

    protected override void OnDisable()
    {
        IsPressed = false;
        pressAmount = 0f;
        base.OnDisable();
    }

    private void LateUpdate()
    {
        // Read the working virtual control rather than introducing a second
        // pointer handler or selectable button that could steal touch/focus.
        IsPressed = inputSource != null && inputSource.control switch
        {
            ButtonControl button => button.isPressed,
            Vector2Control stick => stick.ReadValue().sqrMagnitude > 0.01f,
            _ => false,
        };
        float next = Mathf.MoveTowards(pressAmount, IsPressed ? 1f : 0f,
            Time.unscaledDeltaTime * 12f);
        if (Mathf.Approximately(next, pressAmount))
            return;

        pressAmount = next;
        SetVerticesDirty();
    }

    protected override void OnPopulateMesh(VertexHelper mesh)
    {
        mesh.Clear();
        Rect rect = GetPixelAdjustedRect();
        float diameter = Mathf.Min(rect.width, rect.height);
        if (diameter <= 0f)
            return;

        Vector2 center = rect.center;
        float radius = diameter * 0.475f;
        bool isBase = controlStyle == Style.JoystickBase;
        bool isKnob = controlStyle == Style.JoystickKnob;
        float strength = isBase ? 0.62f : 1f;

        AddDisc(mesh, center + Vector2.down * diameter * 0.018f,
            radius + diameter * 0.016f, Ink, 0.12f * strength, 0f);
        AddDisc(mesh, center, radius, Ink,
            (isKnob ? 0.12f : 0.07f) + pressAmount * 0.035f, 0.16f * strength);
        AddDisc(mesh, center, radius * 0.97f, Pearl,
            (isBase ? 0.008f : 0.025f) + pressAmount * 0.018f, 0.055f * strength);

        // Separate rim geometry keeps bright reflections out of the clear center.
        AddRing(mesh, center, radius, diameter * 0.018f,
            (0.5f + pressAmount * 0.26f) * strength, true);
        AddRing(mesh, center, radius - diameter * 0.043f,
            diameter * 0.008f, 0.15f * strength, true);
        AddReflection(mesh, center, radius * 0.91f, diameter * 0.08f,
            42f, 153f, 0.12f * strength);
        AddReflection(mesh, center, radius - diameter * 0.01f,
            diameter * 0.013f, 48f, 145f, (0.5f + pressAmount * 0.2f) * strength);
        AddReflection(mesh, center, radius - diameter * 0.023f,
            diameter * 0.01f, 235f, 301f, 0.25f * strength);

        if (isBase)
        {
            AddDirectionMarks(mesh, center, radius);
            return;
        }

        if (isKnob)
        {
            for (int index = -1; index <= 1; index++)
                AddDisc(mesh, center + Vector2.right * index * diameter * 0.12f,
                    diameter * 0.025f, Pearl, 0.57f, 0.57f);
            return;
        }

        float iconSize = diameter * Mathf.Lerp(0.43f, 0.405f, pressAmount);
        Vector2 iconCenter = center + Vector2.down * pressAmount * diameter * 0.008f;
        DrawIcon(mesh, iconCenter + Vector2.down * diameter * 0.012f,
            iconSize, diameter * 0.036f, Tint(Ink, 0.55f));
        DrawIcon(mesh, iconCenter, iconSize, diameter * 0.025f,
            Tint(Pearl, Mathf.Lerp(0.84f, 1f, pressAmount)));
    }

    private void DrawIcon(VertexHelper mesh, Vector2 center, float size,
        float stroke, Color tint)
    {
        Vector2 Point(float x, float y) => center + new Vector2(x, y) * size;
        void Line(float x1, float y1, float x2, float y2) =>
            AddLine(mesh, Point(x1, y1), Point(x2, y2), stroke, tint);

        switch (controlStyle)
        {
            case Style.Jump:
                Line(0f, -0.3f, 0f, 0.43f);
                Line(-0.32f, 0.1f, 0f, 0.43f);
                Line(0f, 0.43f, 0.32f, 0.1f);
                Line(-0.31f, -0.45f, 0.31f, -0.45f);
                break;
            case Style.Dash:
                Line(-0.15f, -0.34f, 0.19f, 0f);
                Line(0.19f, 0f, -0.15f, 0.34f);
                Line(0.17f, -0.34f, 0.51f, 0f);
                Line(0.51f, 0f, 0.17f, 0.34f);
                Line(-0.5f, 0.16f, -0.25f, 0.16f);
                Line(-0.56f, -0.1f, -0.31f, -0.1f);
                break;
            case Style.Fire:
                AddArc(mesh, center, size * 0.32f, stroke, 0f, 360f, tint);
                Line(0f, 0.23f, 0f, 0.5f);
                Line(0f, -0.5f, 0f, -0.23f);
                Line(-0.5f, 0f, -0.23f, 0f);
                Line(0.23f, 0f, 0.5f, 0f);
                AddDisc(mesh, center, size * 0.06f, tint, tint.a, tint.a, false);
                break;
        }
    }

    private void AddDirectionMarks(VertexHelper mesh, Vector2 center, float radius)
    {
        for (int index = 0; index < 4; index++)
        {
            float angle = 90f * index;
            AddLine(mesh, PointOnCircle(center, radius * 0.72f, angle),
                PointOnCircle(center, radius * 0.79f, angle),
                radius * 0.022f, Tint(Pearl, 0.25f));
        }
    }

    private void AddDisc(VertexHelper mesh, Vector2 center, float radius,
        Color hue, float centerAlpha, float edgeAlpha, bool applyTint = true)
    {
        int first = mesh.currentVertCount;
        Color AtAlpha(float alpha) => applyTint ? Tint(hue, alpha) : new Color(hue.r, hue.g, hue.b, alpha);
        mesh.AddVert(center, AtAlpha(centerAlpha), Vector2.zero);
        for (int index = 0; index <= CircleSegments; index++)
            mesh.AddVert(PointOnCircle(center, radius, index * 360f / CircleSegments),
                AtAlpha(edgeAlpha), Vector2.zero);
        for (int index = 0; index < CircleSegments; index++)
            mesh.AddTriangle(first, first + index + 1, first + index + 2);
    }

    private void AddRing(VertexHelper mesh, Vector2 center, float radius,
        float width, float opacity, bool directional)
    {
        for (int index = 0; index < CircleSegments; index++)
        {
            float start = index * 360f / CircleSegments;
            float end = (index + 1) * 360f / CircleSegments;
            Color Reflection(float angle)
            {
                float light = directional ? (Mathf.Cos((angle - 130f) * Mathf.Deg2Rad) + 1f) * 0.5f : 1f;
                return Tint(Color.Lerp(Slate, Pearl, light), opacity * Mathf.Lerp(0.35f, 1f, light));
            }
            AddQuad(mesh, PointOnCircle(center, radius - width, start),
                PointOnCircle(center, radius, start), PointOnCircle(center, radius, end),
                PointOnCircle(center, radius - width, end), Reflection(start), Reflection(end));
        }
    }

    private void AddReflection(VertexHelper mesh, Vector2 center, float radius,
        float width, float start, float end, float opacity)
    {
        const int segments = 20;
        for (int index = 0; index < segments; index++)
        {
            float a = index / (float)segments;
            float b = (index + 1f) / segments;
            Color first = Tint(Pearl, Mathf.Sin(a * Mathf.PI) * opacity);
            Color second = Tint(Pearl, Mathf.Sin(b * Mathf.PI) * opacity);
            float angleA = Mathf.Lerp(start, end, a);
            float angleB = Mathf.Lerp(start, end, b);
            AddQuad(mesh, PointOnCircle(center, radius - width, angleA),
                PointOnCircle(center, radius, angleA), PointOnCircle(center, radius, angleB),
                PointOnCircle(center, radius - width, angleB), first, second);
        }
    }

    private static void AddArc(VertexHelper mesh, Vector2 center, float radius,
        float width, float start, float end, Color tint)
    {
        const int segments = 24;
        for (int index = 0; index < segments; index++)
            AddLine(mesh, PointOnCircle(center, radius, Mathf.Lerp(start, end, index / (float)segments)),
                PointOnCircle(center, radius, Mathf.Lerp(start, end, (index + 1f) / segments)), width, tint);
    }

    private static Vector2 PointOnCircle(Vector2 center, float radius, float degrees)
    {
        float radians = degrees * Mathf.Deg2Rad;
        return center + new Vector2(Mathf.Cos(radians), Mathf.Sin(radians)) * radius;
    }

    private Color Tint(Color hue, float opacity) =>
        new(hue.r * color.r, hue.g * color.g, hue.b * color.b, opacity * color.a);

    private static void AddLine(VertexHelper mesh, Vector2 start, Vector2 end,
        float width, Color tint)
    {
        Vector2 direction = end - start;
        Vector2 normal = new Vector2(-direction.y, direction.x).normalized * width * 0.5f;
        AddQuad(mesh, start - normal, start + normal, end + normal, end - normal, tint, tint);
    }

    private static void AddQuad(VertexHelper mesh, Vector2 a, Vector2 b,
        Vector2 c, Vector2 d, Color start, Color end)
    {
        int first = mesh.currentVertCount;
        mesh.AddVert(a, start, Vector2.zero);
        mesh.AddVert(b, start, Vector2.zero);
        mesh.AddVert(c, end, Vector2.zero);
        mesh.AddVert(d, end, Vector2.zero);
        mesh.AddTriangle(first, first + 1, first + 2);
        mesh.AddTriangle(first, first + 2, first + 3);
    }
}
