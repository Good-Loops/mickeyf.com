using System;
using System.Collections;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

/// <summary>
/// Connects the Figma-authored menu to the existing run and audio services.
/// </summary>
[DisallowMultipleComponent]
[RequireComponent(typeof(UIDocument))]
[DefaultExecutionOrder(100)]
public sealed class MainMenuController : MonoBehaviour
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void MickeyfThreeBossesSignalReady();
#endif

    private static readonly Vector2 ArtworkSize = new(1672f, 941f);
    // Center of the artwork's inner rails: x 610..1053, y 746..862.
    private static readonly Vector2 PlayCenter = new(831.5f, 804f);
    private static readonly Vector2 AudioCenter = new(1543f, 113f);
    private const float MinimumHitSize = 48f;
    private const string FirstLevelSceneName = "Level1_BeeBoss";

    [SerializeField] private UIDocument document;
    [SerializeField] private Texture2D menuArtwork;
    [SerializeField] private StyleSheet presentationStyle;
    [SerializeField] private Texture2D enabledIcon;
    [SerializeField] private Texture2D mutedIcon;

    private VisualElement documentRoot;
    private VisualElement master;
    private VisualElement artwork;
    private Button playButton;
    private Button audioButton;
    private Image audioIcon;
    private bool addedPresentationStyle;
    private bool isLoading;
    private Rect lastScreenSafeArea;
    private Vector2Int lastScreenSize;

    private void OnEnable()
    {
        if (!TryBindImportedMenu(out string error))
        {
            Debug.LogError($"Main Menu UI Toolkit: {error}", this);
            enabled = false;
            return;
        }

        isLoading = false;
        Time.timeScale = 1f;
        playButton.SetEnabled(true);
        audioButton.SetEnabled(true);
        playButton.clicked += StartNewRun;
        audioButton.clicked += ToggleAudio;
        GameAudioSettings.Changed += RefreshAudioIcon;
        documentRoot.RegisterCallback<GeometryChangedEvent>(OnGeometryChanged);
        RefreshAudioIcon(GameAudioSettings.IsEnabled);
        RefreshScreenLayout();
        playButton.Focus();
    }

#if UNITY_WEBGL && !UNITY_EDITOR
    private void Start()
    {
        StartCoroutine(SignalBrowserReadyAfterSplash());
    }

    private static IEnumerator SignalBrowserReadyAfterSplash()
    {
        while (!UnityEngine.Rendering.SplashScreen.isFinished)
            yield return null;

        // Let the menu draw before dismissing the website's loading screen.
        yield return new WaitForEndOfFrame();
        MickeyfThreeBossesSignalReady();
    }
#endif

    private bool TryBindImportedMenu(out string error)
    {
        document ??= GetComponent<UIDocument>();
        documentRoot = document != null ? document.rootVisualElement : null;
        if (documentRoot == null || document.panelSettings == null || menuArtwork == null || presentationStyle == null ||
            enabledIcon == null || mutedIcon == null)
        {
            error = "Assign the UIDocument with PanelSettings, existing menu artwork, presentation stylesheet, and both audio icons.";
            return false;
        }

        if (documentRoot.childCount != 1 || documentRoot[0].childCount < 1)
        {
            error = "Expected one imported master with the artwork as its first child. Recheck the imported UXML.";
            return false;
        }

        master = documentRoot[0];
        artwork = master[0];
        // Only the controls own touches; swiping the artwork should scroll the website.
        documentRoot.pickingMode = PickingMode.Ignore;
        master.pickingMode = PickingMode.Ignore;
        artwork.pickingMode = PickingMode.Ignore;
        var buttons = artwork.Query<Button>().ToList();
        if (buttons.Count != 2)
        {
            error = $"Expected exactly two imported buttons under the artwork; found {buttons.Count}.";
            return false;
        }

        playButton = buttons.Find(button => string.Equals(button.text?.Trim(), "PLAY", StringComparison.Ordinal));
        audioButton = buttons.Find(button => string.IsNullOrWhiteSpace(button.text));
        if (playButton == null || audioButton == null || playButton == audioButton)
        {
            error = "Expected a PLAY button and a blank-caption audio button. Recheck the Figma control mappings.";
            return false;
        }

        master.name = "pilot-master";
        artwork.name = "pilot-artwork";
        playButton.name = "pilot-play-button";
        audioButton.name = "pilot-audio-button";
        master.AddToClassList("main-menu-toolkit-pilot");
        playButton.AddToClassList("pilot-menu-button");
        audioButton.AddToClassList("pilot-menu-button");
        // Let interaction styles override the imported inline caption color.
        playButton.style.color = StyleKeyword.Null;
        artwork.style.backgroundImage = new StyleBackground(menuArtwork);
        artwork.style.overflow = Overflow.Visible;

        addedPresentationStyle = !documentRoot.styleSheets.Contains(presentationStyle);
        if (addedPresentationStyle)
            documentRoot.styleSheets.Add(presentationStyle);

        // Replace the imported Button icon rather than drawing a second stateful icon over it.
        audioButton.hierarchy.Clear();
        audioIcon = new Image
        {
            name = "pilot-audio-icon",
            pickingMode = PickingMode.Ignore,
            scaleMode = ScaleMode.ScaleToFit
        };
        audioButton.Add(audioIcon);
        error = null;
        return true;
    }

    private void Update()
    {
        if (Screen.safeArea != lastScreenSafeArea ||
            Screen.width != lastScreenSize.x || Screen.height != lastScreenSize.y)
            RefreshScreenLayout();
    }

    private void OnGeometryChanged(GeometryChangedEvent _)
    {
        RefreshScreenLayout();
    }

    private void RefreshScreenLayout()
    {
        lastScreenSafeArea = Screen.safeArea;
        lastScreenSize = new Vector2Int(Screen.width, Screen.height);
        Rect panelViewport = documentRoot.contentRect;
        if (lastScreenSize.x <= 0 || lastScreenSize.y <= 0 ||
            panelViewport.width <= 0f || panelViewport.height <= 0f)
            return;

        // Screen.safeArea starts at the bottom-left; UI Toolkit layout starts at the top-left.
        float scaleX = panelViewport.width / lastScreenSize.x;
        float scaleY = panelViewport.height / lastScreenSize.y;
        var panelSafeArea = new Rect(
            panelViewport.x + lastScreenSafeArea.x * scaleX,
            panelViewport.y + (lastScreenSize.y - lastScreenSafeArea.yMax) * scaleY,
            lastScreenSafeArea.width * scaleX,
            lastScreenSafeArea.height * scaleY);
        UpdateLayout(panelViewport, panelSafeArea);
    }

    /// <summary>
    /// Fits the artwork and controls into top-left-origin panel rectangles.
    /// The panel uses constant pixel size at scale 1, so 48 panel units are 48 screen pixels.
    /// </summary>
    public void UpdateLayout(Rect viewport, Rect safeArea)
    {
        if (master == null || artwork == null || playButton == null || audioButton == null ||
            viewport.width <= 0f || viewport.height <= 0f)
            return;

        Rect safe = IntersectSafeArea(viewport, safeArea);
        float scale = Mathf.Min(safe.width / ArtworkSize.x, safe.height / ArtworkSize.y);
        scale = LimitScaleForHitTarget(scale, safe.size, PlayCenter);
        scale = LimitScaleForHitTarget(scale, safe.size, AudioCenter);
        Vector2 size = ArtworkSize * scale;
        var artRect = new Rect(safe.center - size * 0.5f, size);

        SetBounds(master, viewport);
        SetBounds(artwork, new Rect(artRect.position - viewport.position, artRect.size));
        SetButtonBounds(playButton, PlayCenter, new Vector2(490f, 125f), scale, safe.size);
        SetButtonBounds(audioButton, AudioCenter, new Vector2(142f, 78f), scale, safe.size);
        float captionSize = Mathf.Max(18f, 58f * scale);
        playButton.style.fontSize = captionSize;
        // Oxanium's PLAY ink sits 1.5px right and 3.18px high at 58px.
        // Asymmetric padding shifts the caption, not its centered touch target.
        playButton.style.paddingRight = captionSize * (3f / 58f);
        playButton.style.paddingTop = captionSize * (6.36f / 58f);

        float iconHeight = Mathf.Min(Mathf.Max(20f, 37f * scale), safe.height);
        float iconWidth = iconHeight * 64f / 44f;
        if (iconWidth > safe.width)
        {
            iconWidth = safe.width;
            iconHeight = iconWidth * 44f / 64f;
        }

        // Center the symbol independently of its larger touch target.
        audioIcon.style.width = iconWidth;
        audioIcon.style.height = iconHeight;
        audioIcon.style.flexShrink = 0f;
    }

    private static Rect IntersectSafeArea(Rect viewport, Rect safeArea)
    {
        Rect intersection = Rect.MinMaxRect(
            Mathf.Max(viewport.xMin, safeArea.xMin),
            Mathf.Max(viewport.yMin, safeArea.yMin),
            Mathf.Min(viewport.xMax, safeArea.xMax),
            Mathf.Min(viewport.yMax, safeArea.yMax));
        return intersection.width > 0f && intersection.height > 0f ? intersection : viewport;
    }

    private static float LimitScaleForHitTarget(float scale, Vector2 safeSize, Vector2 center)
    {
        Vector2 offset = center - ArtworkSize * 0.5f;
        // Reserve the expanded touch target around its authored center instead of moving the icon.
        if (Mathf.Abs(offset.x) > 0f)
            scale = Mathf.Min(scale, Mathf.Max(0f, safeSize.x - MinimumHitSize) / (2f * Mathf.Abs(offset.x)));
        if (Mathf.Abs(offset.y) > 0f)
            scale = Mathf.Min(scale, Mathf.Max(0f, safeSize.y - MinimumHitSize) / (2f * Mathf.Abs(offset.y)));
        return scale;
    }

    private static Vector2 HitSize(Vector2 authoredSize, float scale, Vector2 safeSize)
    {
        // A viewport smaller than the minimum target can only offer its available area.
        return new Vector2(
            Mathf.Min(safeSize.x, Mathf.Max(MinimumHitSize, authoredSize.x * scale)),
            Mathf.Min(safeSize.y, Mathf.Max(MinimumHitSize, authoredSize.y * scale)));
    }

    private static void SetButtonBounds(Button button, Vector2 center, Vector2 authoredSize,
        float scale, Vector2 safeSize)
    {
        Vector2 hitSize = HitSize(authoredSize, scale, safeSize);
        SetBounds(button, new Rect(center * scale - hitSize * 0.5f, hitSize));
    }

    private static void SetBounds(VisualElement element, Rect bounds)
    {
        element.style.position = Position.Absolute;
        element.style.left = bounds.x;
        element.style.top = bounds.y;
        element.style.width = bounds.width;
        element.style.height = bounds.height;
    }

    private void StartNewRun()
    {
        if (isLoading)
            return;

        isLoading = true;
        playButton.SetEnabled(false);
        audioButton.SetEnabled(false);
        Time.timeScale = 1f;
        RunSessionService.Instance.Session.BeginNewRun();
        SceneManager.LoadScene(FirstLevelSceneName);
    }

    private void ToggleAudio()
    {
        if (!isLoading)
            GameAudioSettings.Toggle();
    }

    private void RefreshAudioIcon(bool isEnabled)
    {
        if (audioIcon == null)
            return;

        audioIcon.image = isEnabled ? enabledIcon : mutedIcon;
        audioButton.tooltip = isEnabled ? "Mute audio" : "Enable audio";
        audioButton.EnableInClassList("audio-muted", !isEnabled);
    }

    private void OnDisable()
    {
        if (playButton != null)
            playButton.clicked -= StartNewRun;
        if (audioButton != null)
            audioButton.clicked -= ToggleAudio;
        GameAudioSettings.Changed -= RefreshAudioIcon;
        documentRoot?.UnregisterCallback<GeometryChangedEvent>(OnGeometryChanged);
        audioIcon?.RemoveFromHierarchy();
        audioIcon = null;
        if (addedPresentationStyle && documentRoot != null)
            documentRoot.styleSheets.Remove(presentationStyle);
        addedPresentationStyle = false;
    }
}
