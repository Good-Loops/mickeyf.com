using System.Collections;
using UnityEngine;
using UnityEngine.UIElements;

/// <summary>Places native controls over the existing painted outcome artwork.</summary>
[DisallowMultipleComponent]
[RequireComponent(typeof(UIDocument))]
[DefaultExecutionOrder(50)]
public sealed class OutcomeScreenView : MonoBehaviour
{
    public enum ScreenKind { BeeDefeat, CyborgDefeat, KrakenDefeat, BeeTransition, CyborgTransition, Completion }

    private static readonly Vector2 ArtworkSize = new(1672f, 941f);
    private const float MinimumHitSize = 48f;

    [SerializeField] private UIDocument document;
    [SerializeField] private Texture2D artwork;
    [SerializeField] private StyleSheet presentationStyle;
    [SerializeField] private Font font;
    [SerializeField] private ScreenKind screenKind;

    private VisualElement documentRoot;
    private VisualElement root;
    private VisualElement artworkElement;
    private VisualElement fade;
    private Label timeCaption;
    private Label timeValue;
    private Label splitCaption;
    private Label scoreValue;
    private Label rankValue;
    private RunSessionService runSessionService;
    private Coroutine fadeRoutine;
    private Rect lastSafeArea;
    private Vector2Int lastScreenSize;
    private Rect lastViewport;
    private Rect lastPanelSafeArea;
    private bool addedStyle;

    public Button TryAgainButton { get; private set; }
    public Button BackToMenuButton { get; private set; }
    public Button SubmitScoreButton { get; private set; }
    public bool IsReady => root != null;
    private bool IsTransition => screenKind == ScreenKind.BeeTransition || screenKind == ScreenKind.CyborgTransition;
    private bool IsCompletion => screenKind == ScreenKind.Completion;

    private void OnEnable()
    {
        document ??= GetComponent<UIDocument>();
        documentRoot = document != null ? document.rootVisualElement : null;
        if (documentRoot == null || document.panelSettings == null || artwork == null ||
            presentationStyle == null || font == null)
        {
            Debug.LogError("Outcome UI requires a document, panel, artwork, stylesheet, and font.", this);
            return;
        }

        root = documentRoot.Q("outcome-root");
        artworkElement = documentRoot.Q("outcome-artwork");
        fade = documentRoot.Q("outcome-fade");
        timeCaption = documentRoot.Q<Label>("time-caption");
        timeValue = documentRoot.Q<Label>("time-value");
        splitCaption = documentRoot.Q<Label>("split-caption");
        scoreValue = documentRoot.Q<Label>("score-value");
        rankValue = documentRoot.Q<Label>("rank-value");
        TryAgainButton = documentRoot.Q<Button>("try-again-button");
        BackToMenuButton = documentRoot.Q<Button>("back-to-menu-button");
        SubmitScoreButton = documentRoot.Q<Button>("submit-score-button");
        if (root == null || artworkElement == null || fade == null || timeCaption == null ||
            timeValue == null || splitCaption == null || scoreValue == null || rankValue == null ||
            TryAgainButton == null || BackToMenuButton == null || SubmitScoreButton == null)
        {
            root = null;
            Debug.LogError("OutcomeScreen.uxml is missing a required named element.", this);
            return;
        }

        addedStyle = !documentRoot.styleSheets.Contains(presentationStyle);
        if (addedStyle)
            documentRoot.styleSheets.Add(presentationStyle);
        documentRoot.pickingMode = PickingMode.Ignore;
        root.pickingMode = PickingMode.Ignore;
        artworkElement.pickingMode = PickingMode.Ignore;
        // The runtime theme supplies a font definition, which takes precedence
        // over the older unityFont property even when that property is inherited.
        foreach (TextElement text in artworkElement.Query<TextElement>().ToList())
            text.style.unityFontDefinition = FontDefinition.FromFont(font);
        artworkElement.style.backgroundImage = new StyleBackground(artwork);
        SetVisible(timeCaption, screenKind == ScreenKind.CyborgDefeat || screenKind == ScreenKind.KrakenDefeat);
        SetVisible(splitCaption, IsTransition);
        SetVisible(scoreValue, IsCompletion);
        SetVisible(rankValue, IsCompletion);
        SetVisible(TryAgainButton, !IsTransition);
        SetVisible(BackToMenuButton, !IsTransition);
        SetVisible(SubmitScoreButton, IsCompletion);
        Color accent = screenKind == ScreenKind.BeeDefeat || screenKind == ScreenKind.BeeTransition
            ? new Color(0.58f, 0.86f, 0f)
            : screenKind == ScreenKind.KrakenDefeat ? new Color(0.68f, 0.24f, 1f)
            : new Color(1f, 0.12f, 0.08f);
        timeValue.style.color = IsCompletion ? Color.white : accent;
        timeCaption.style.color = accent;
        SetFadeAlpha(1f);
        runSessionService = RunSessionService.Instance;
        runSessionService.PortraitUiLayoutChanged += RefreshScreenLayout;
        documentRoot.RegisterCallback<GeometryChangedEvent>(OnGeometryChanged);
        RefreshScreenLayout();
    }

    private void OnDisable()
    {
        if (runSessionService != null)
            runSessionService.PortraitUiLayoutChanged -= RefreshScreenLayout;
        documentRoot?.UnregisterCallback<GeometryChangedEvent>(OnGeometryChanged);
        if (addedStyle && documentRoot != null)
            documentRoot.styleSheets.Remove(presentationStyle);
        if (fadeRoutine != null)
            StopCoroutine(fadeRoutine);
        fadeRoutine = null;
        root = null;
        addedStyle = false;
    }

    private void Update()
    {
        if (Screen.safeArea != lastSafeArea || Screen.width != lastScreenSize.x || Screen.height != lastScreenSize.y)
            RefreshScreenLayout();
    }

    private void OnGeometryChanged(GeometryChangedEvent _) => RefreshScreenLayout();

    private void RefreshScreenLayout()
    {
        if (!IsReady)
            return;
        lastSafeArea = Screen.safeArea;
        lastScreenSize = new Vector2Int(Screen.width, Screen.height);
        Rect viewport = documentRoot.contentRect;
        if (Screen.width <= 0 || Screen.height <= 0 || viewport.width <= 0f || viewport.height <= 0f)
            return;
        float scaleX = viewport.width / Screen.width;
        float scaleY = viewport.height / Screen.height;
        UpdateLayout(viewport, new Rect(
            viewport.x + lastSafeArea.x * scaleX,
            viewport.y + (Screen.height - lastSafeArea.yMax) * scaleY,
            lastSafeArea.width * scaleX, lastSafeArea.height * scaleY));
    }

    public void SetValues(string time, string score = "", string rank = "")
    {
        timeValue.text = time;
        scoreValue.text = score;
        rankValue.text = rank;
        UpdateLayout(lastViewport, lastPanelSafeArea);
    }

    public void SetSubmission(string label, bool enabled)
    {
        SubmitScoreButton.text = label;
        SubmitScoreButton.tooltip = label;
        SubmitScoreButton.SetEnabled(enabled);
        UpdateLayout(lastViewport, lastPanelSafeArea);
    }

    public void SetNavigationEnabled(bool enabled)
    {
        TryAgainButton.SetEnabled(enabled);
        BackToMenuButton.SetEnabled(enabled);
        SubmitScoreButton.SetEnabled(enabled);
    }

    public void FocusFirstAction() => TryAgainButton.Focus();

    public void FadeIn(float seconds) => StartFade(1f, seconds);
    public void FadeOut(float seconds) => StartFade(0f, seconds);

    private void StartFade(float target, float seconds)
    {
        if (fadeRoutine != null)
            StopCoroutine(fadeRoutine);
        fadeRoutine = StartCoroutine(FadeTo(target, seconds));
    }

    private IEnumerator FadeTo(float target, float seconds)
    {
        float from = fade.style.opacity.value;
        for (float elapsed = 0f; elapsed < seconds; elapsed += Time.unscaledDeltaTime)
        {
            SetFadeAlpha(Mathf.Lerp(from, target, elapsed / seconds));
            yield return null;
        }
        SetFadeAlpha(target);
        fadeRoutine = null;
    }

    private void SetFadeAlpha(float alpha)
    {
        fade.style.opacity = alpha;
        fade.pickingMode = alpha > 0.001f ? PickingMode.Position : PickingMode.Ignore;
    }

    /// <summary>Uses top-left panel coordinates; the shared panel renders at one unit per pixel.</summary>
    public void UpdateLayout(Rect viewport, Rect safeArea)
    {
        if (!IsReady || viewport.width <= 0f || viewport.height <= 0f)
            return;
        lastViewport = viewport;
        lastPanelSafeArea = safeArea;
        Rect safe = Rect.MinMaxRect(Mathf.Max(viewport.xMin, safeArea.xMin), Mathf.Max(viewport.yMin, safeArea.yMin),
            Mathf.Min(viewport.xMax, safeArea.xMax), Mathf.Min(viewport.yMax, safeArea.yMax));
        if (safe.width <= 0f || safe.height <= 0f)
            safe = viewport;

        GetArtworkBounds(out Rect time, out Rect again, out Rect menu);
        Rect submit = new(1026f, 812f, 352f, 103f);
        float scale = Mathf.Min(safe.width / ArtworkSize.x, safe.height / ArtworkSize.y);
        if (!IsTransition)
        {
            scale = ReserveHitTarget(scale, safe.size, again.center);
            scale = ReserveHitTarget(scale, safe.size, menu.center);
            if (IsCompletion)
                scale = ReserveHitTarget(scale, safe.size, submit.center);
        }
        SetBounds(root, viewport);
        SetBounds(fade, new Rect(Vector2.zero, viewport.size));
        Vector2 artSize = ArtworkSize * scale;
        SetBounds(artworkElement, new Rect(safe.center - viewport.position - artSize * 0.5f, artSize));

        bool portrait = viewport.height > viewport.width || (runSessionService != null && runSessionService.UsePortraitUiLayout);
        if (IsTransition)
        {
            float top = screenKind == ScreenKind.BeeTransition ? 315f : 298f;
            Rect caption = portrait ? new Rect(536f, top, 300f, 36f) : new Rect(74f, 58f, 300f, 30f);
            time = portrait ? new Rect(836f, top, 300f, 36f) : new Rect(74f, 88f, 300f, 44f);
            SetTextBounds(splitCaption, caption, scale, 22f);
        }
        SetTextBounds(timeValue, time, scale, IsCompletion ? 46f : IsTransition ? 32f : 52f);
        if (screenKind == ScreenKind.CyborgDefeat || screenKind == ScreenKind.KrakenDefeat)
        {
            float center = screenKind == ScreenKind.CyborgDefeat ? 856f : 855f;
            SetTextBounds(timeCaption, new Rect(center - 150f, 552f, 300f, 40f), scale, 24f);
        }
        if (IsCompletion)
        {
            SetTextBounds(scoreValue, new Rect(704f, 690f, 258f, 78f), scale, 46f);
            SetTextBounds(rankValue, new Rect(998f, 690f, 310f, 78f), scale, 42f);
            SetButtonBounds(SubmitScoreButton, submit, scale, safe.size, 25f);
        }
        if (!IsTransition)
        {
            SetButtonBounds(TryAgainButton, again, scale, safe.size, IsCompletion ? 30f : 32f);
            SetButtonBounds(BackToMenuButton, menu, scale, safe.size, IsCompletion ? 27f : 30f);
        }
    }

    private void GetArtworkBounds(out Rect time, out Rect again, out Rect menu)
    {
        switch (screenKind)
        {
            case ScreenKind.CyborgDefeat:
                time = new Rect(571f, 592f, 570f, 74f);
                again = new Rect(431.5f, 720.5f, 383f, 149f);
                menu = new Rect(859f, 720.5f, 389f, 149f);
                break;
            case ScreenKind.KrakenDefeat:
                time = new Rect(570f, 592f, 570f, 74f);
                again = new Rect(432.5f, 720.5f, 383f, 149f);
                menu = new Rect(857f, 720.5f, 389f, 149f);
                break;
            case ScreenKind.Completion:
                time = new Rect(385f, 690f, 300f, 78f);
                again = new Rect(285f, 812f, 365f, 103f);
                menu = new Rect(674f, 812f, 325f, 103f);
                break;
            default:
                time = new Rect(535f, 580f, 605f, 72f);
                again = new Rect(368f, 751f, 432f, 110f);
                menu = new Rect(874f, 751f, 424f, 110f);
                break;
        }
    }

    private static float ReserveHitTarget(float scale, Vector2 available, Vector2 center)
    {
        Vector2 offset = center - ArtworkSize * 0.5f;
        if (Mathf.Abs(offset.x) > 0f)
            scale = Mathf.Min(scale, Mathf.Max(0f, available.x - MinimumHitSize) / (2f * Mathf.Abs(offset.x)));
        if (Mathf.Abs(offset.y) > 0f)
            scale = Mathf.Min(scale, Mathf.Max(0f, available.y - MinimumHitSize) / (2f * Mathf.Abs(offset.y)));
        return scale;
    }

    private static void SetTextBounds(Label label, Rect authored, float scale, float fontSize)
    {
        Rect bounds = new(authored.position * scale, authored.size * scale);
        // Native labels stay centered on the painted readout even at phone width.
        float fitSize = bounds.width / (Mathf.Max(1, label.text.Length) * 0.65f);
        float captionSize = Mathf.Min(Mathf.Max(11f, fontSize * scale), fitSize);
        Vector2 center = bounds.center;
        bounds.height = Mathf.Max(bounds.height, captionSize * 1.4f);
        bounds.center = center;
        SetBounds(label, bounds);
        label.style.fontSize = captionSize;
        label.style.paddingTop = captionSize * 0.11f;
    }

    private static void SetButtonBounds(Button button, Rect authored, float scale, Vector2 available, float fontSize)
    {
        Vector2 size = new(Mathf.Min(available.x, Mathf.Max(MinimumHitSize, authored.width * scale)),
            Mathf.Min(available.y, Mathf.Max(MinimumHitSize, authored.height * scale)));
        SetBounds(button, new Rect(authored.center * scale - size * 0.5f, size));
        // The invisible touch target may grow beyond the painted frame, but its
        // single-line caption must still fit the original artwork's interior.
        float paintedWidth = Mathf.Max(1f, authored.width * scale - 8f);
        float paintedHeight = Mathf.Max(1f, authored.height * scale);
        float captionSize = Mathf.Min(Mathf.Max(12f, fontSize * scale),
            paintedWidth / (Mathf.Max(1, button.text.Length) * 0.65f), paintedHeight / 1.4f);
        button.style.fontSize = captionSize;
        button.style.paddingTop = captionSize * 0.11f;
    }

    private static void SetVisible(VisualElement element, bool visible) =>
        element.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;

    private static void SetBounds(VisualElement element, Rect bounds)
    {
        element.style.position = Position.Absolute;
        element.style.left = bounds.x;
        element.style.top = bounds.y;
        element.style.width = bounds.width;
        element.style.height = bounds.height;
    }
}
