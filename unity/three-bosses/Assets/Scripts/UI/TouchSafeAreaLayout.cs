using UnityEngine;

/// <summary>
/// Keeps the mobile touch controls inside the device safe area.
/// </summary>
[DisallowMultipleComponent]
public sealed class TouchSafeAreaLayout : MonoBehaviour
{
    private static readonly Rect FullScreenAnchors = new(0f, 0f, 1f, 1f);

    [SerializeField] private RectTransform controlsRoot;

    private Rect lastSafeArea = new(-1f, -1f, -1f, -1f);
    private Vector2Int lastScreenSize = new(-1, -1);

    private void OnEnable()
    {
        RefreshLayout();
    }

    private void Update()
    {
        Rect safeArea = Screen.safeArea;
        var screenSize = new Vector2Int(Screen.width, Screen.height);
        if (safeArea == lastSafeArea && screenSize == lastScreenSize)
            return;

        ApplyLayout(safeArea, screenSize);
    }

    public void RefreshLayout()
    {
        ApplyLayout(Screen.safeArea, new Vector2Int(Screen.width, Screen.height));
    }

    private void ApplyLayout(Rect safeArea, Vector2Int screenSize)
    {
        lastSafeArea = safeArea;
        lastScreenSize = screenSize;

        if (controlsRoot == null)
            return;

        Rect anchors = CalculateAnchors(safeArea, screenSize);
        controlsRoot.anchorMin = anchors.min;
        controlsRoot.anchorMax = anchors.max;
        controlsRoot.offsetMin = Vector2.zero;
        controlsRoot.offsetMax = Vector2.zero;
    }

    internal static Rect CalculateAnchors(Rect safeArea, Vector2 screenSize)
    {
        if (screenSize.x <= 0f || screenSize.y <= 0f ||
            safeArea.width <= 0f || safeArea.height <= 0f)
            return FullScreenAnchors;

        float minimumX = Mathf.Clamp01(safeArea.xMin / screenSize.x);
        float minimumY = Mathf.Clamp01(safeArea.yMin / screenSize.y);
        float maximumX = Mathf.Clamp01(safeArea.xMax / screenSize.x);
        float maximumY = Mathf.Clamp01(safeArea.yMax / screenSize.y);

        if (maximumX <= minimumX || maximumY <= minimumY)
            return FullScreenAnchors;

        return Rect.MinMaxRect(minimumX, minimumY, maximumX, maximumY);
    }
}
