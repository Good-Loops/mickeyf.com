using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

/// <summary>
/// Owns the player-requested pause UI in battle scenes. The persistent run
/// service composes this pause reason with browser visibility suspension.
/// </summary>
[DisallowMultipleComponent]
[RequireComponent(typeof(UIDocument))]
[DefaultExecutionOrder(100)]
public sealed class GameplayPauseController : MonoBehaviour
{
    [SerializeField] private UIDocument document;
    [SerializeField] private PlayerInput playerInput;
    [SerializeField] private string mainMenuSceneName = "MainMenu";

    private VisualElement documentRoot;
    private VisualElement root;
    private VisualElement safeAreaRoot;
    private VisualElement pauseMenu;
    private VisualElement pausePanel;
    private Button pauseButton;
    private Button resumeButton;
    private Button mainMenuButton;
    private RunSessionService runSessionService;
    private bool isNavigating;
    private bool ownsPlayerInputGate;
    private bool playerInputWasEnabled;
    private Rect lastSafeArea = new(-1f, -1f, -1f, -1f);
    private Vector2Int lastScreenSize = new(-1, -1);

    private void OnEnable()
    {
        if (!TryBindMenu())
        {
            Debug.LogError("Gameplay pause UI requires a UIDocument with PanelSettings and the PauseMenu UXML tree.", this);
            enabled = false;
            return;
        }

        runSessionService = RunSessionService.Instance;
        SetButtonsInteractable(true);
        SetPauseMenuVisible(false);
        pauseButton.clicked += TogglePause;
        resumeButton.clicked += ResumeGameplay;
        mainMenuButton.clicked += ReturnToMainMenu;
        pauseButton.RegisterCallback<NavigationSubmitEvent>(IgnorePauseSubmit, TrickleDown.TrickleDown);
        documentRoot.RegisterCallback<GeometryChangedEvent>(OnGeometryChanged);
        RefreshScreenLayout();
        RefreshPauseButton();
    }

    private bool TryBindMenu()
    {
        document ??= GetComponent<UIDocument>();
        documentRoot = document != null ? document.rootVisualElement : null;
        if (documentRoot == null || document.panelSettings == null)
            return false;

        root = documentRoot.Q("pause-root");
        safeAreaRoot = documentRoot.Q("pause-safe-area");
        pauseMenu = documentRoot.Q("pause-overlay");
        pausePanel = documentRoot.Q("pause-panel");
        pauseButton = documentRoot.Q<Button>("pause-open");
        resumeButton = documentRoot.Q<Button>("pause-resume");
        mainMenuButton = documentRoot.Q<Button>("pause-main-menu");
        if (root == null || safeAreaRoot == null || pauseMenu == null || pausePanel == null ||
            pauseButton == null || resumeButton == null || mainMenuButton == null)
            return false;

        documentRoot.pickingMode = PickingMode.Ignore;
        // The opener is pointer-only: Enter is gameplay Fire, not a way to reopen pause.
        pauseButton.focusable = false;
        pauseButton.tabIndex = -1;
        return true;
    }

    private void Update()
    {
        if (Screen.safeArea != lastSafeArea || Screen.width != lastScreenSize.x ||
            Screen.height != lastScreenSize.y)
            RefreshScreenLayout();
        RefreshPauseButton();

        if (!isNavigating && Keyboard.current?.escapeKey.wasPressedThisFrame == true)
            TogglePause();
    }

    private void OnDisable()
    {
        if (pauseButton != null)
        {
            pauseButton.clicked -= TogglePause;
            pauseButton.UnregisterCallback<NavigationSubmitEvent>(IgnorePauseSubmit, TrickleDown.TrickleDown);
        }
        if (resumeButton != null)
            resumeButton.clicked -= ResumeGameplay;
        if (mainMenuButton != null)
            mainMenuButton.clicked -= ReturnToMainMenu;
        documentRoot?.UnregisterCallback<GeometryChangedEvent>(OnGeometryChanged);

        runSessionService?.ResumeFromUserPause();
        RestorePlayerInput();
        runSessionService = null;
        isNavigating = false;
        SetPauseMenuVisible(false);
        if (pauseButton != null)
            pauseButton.style.display = DisplayStyle.None;
        ClearSelection();
    }

    public void TogglePause()
    {
        if (isNavigating || runSessionService == null)
            return;

        if (runSessionService.IsPausedByUser)
        {
            ResumeGameplay();
            return;
        }

        if (!runSessionService.TryPauseForUser())
            return;

        GatePlayerInput();
        SetPauseMenuVisible(true);
        RefreshPauseButton();
        EventSystem.current?.SetSelectedGameObject(null);
        // A previously hidden element becomes focusable after Toolkit resolves display.
        resumeButton.schedule.Execute(FocusResumeButton);
    }

    public void ResumeGameplay()
    {
        if (isNavigating || runSessionService == null)
            return;

        runSessionService.ResumeFromUserPause();
        RestorePlayerInput();
        SetPauseMenuVisible(false);
        RefreshPauseButton();
        // Enter is both Fire and UI Submit, so gameplay must not retain a selected button.
        ClearSelection();
    }

    public void ReturnToMainMenu()
    {
        if (isNavigating || string.IsNullOrWhiteSpace(mainMenuSceneName))
            return;

        isNavigating = true;
        runSessionService?.ResumeFromUserPause();
        RestorePlayerInput();
        SetButtonsInteractable(false);
        ClearSelection();
        SceneManager.LoadScene(mainMenuSceneName);
    }

    private void RefreshPauseButton()
    {
        if (pauseButton == null)
            return;

        bool shouldShow = !isNavigating &&
                          runSessionService != null &&
                          runSessionService.CanPauseByUser;
        pauseButton.style.display = shouldShow ? DisplayStyle.Flex : DisplayStyle.None;
    }

    private static void IgnorePauseSubmit(NavigationSubmitEvent evt)
    {
        evt.StopImmediatePropagation();
    }

    private void FocusResumeButton()
    {
        if (isActiveAndEnabled && !isNavigating && runSessionService != null && runSessionService.IsPausedByUser)
            resumeButton.Focus();
    }

    private void ClearSelection()
    {
        documentRoot?.panel?.focusController.focusedElement?.Blur();
        EventSystem.current?.SetSelectedGameObject(null);
    }

    private void OnGeometryChanged(GeometryChangedEvent _)
    {
        RefreshScreenLayout();
    }

    private void RefreshScreenLayout()
    {
        lastSafeArea = Screen.safeArea;
        lastScreenSize = new Vector2Int(Screen.width, Screen.height);
        Rect viewport = documentRoot.contentRect;
        if (lastScreenSize.x <= 0 || lastScreenSize.y <= 0 || viewport.width <= 0f || viewport.height <= 0f)
            return;

        // Screen safe areas start bottom-left; Toolkit panel coordinates start top-left.
        Vector2 scale = viewport.size / (Vector2)lastScreenSize;
        var safeArea = new Rect(
            viewport.x + lastSafeArea.x * scale.x,
            viewport.y + (lastScreenSize.y - lastSafeArea.yMax) * scale.y,
            lastSafeArea.width * scale.x,
            lastSafeArea.height * scale.y);
        UpdateLayout(viewport, safeArea);
    }

    /// <summary>Uses top-left-origin panel rectangles; the panel is constant-pixel-size at scale 1.</summary>
    public void UpdateLayout(Rect viewport, Rect safeArea)
    {
        if (root == null || viewport.width <= 0f || viewport.height <= 0f)
            return;

        Rect safe = Rect.MinMaxRect(Mathf.Max(viewport.xMin, safeArea.xMin),
            Mathf.Max(viewport.yMin, safeArea.yMin), Mathf.Min(viewport.xMax, safeArea.xMax),
            Mathf.Min(viewport.yMax, safeArea.yMax));
        if (safe.width <= 0f || safe.height <= 0f)
            safe = viewport;

        SetBounds(root, viewport);
        SetBounds(safeAreaRoot, new Rect(safe.position - viewport.position, safe.size));
        SetBounds(pauseMenu, new Rect(Vector2.zero, viewport.size));
        Vector2 hitSize = new(Mathf.Min(48f, safe.width), Mathf.Min(48f, safe.height));
        SetBounds(pauseButton, new Rect(
            Mathf.Max(0f, safe.width - hitSize.x - 22f),
            Mathf.Min(55f, Mathf.Max(0f, safe.height - hitSize.y)), hitSize.x, hitSize.y));
        Vector2 panelSize = new(Mathf.Min(360f, Mathf.Max(48f, safe.width - 32f)),
            Mathf.Min(238f, safe.height));
        SetBounds(pausePanel, new Rect(safe.center - viewport.position - panelSize * 0.5f, panelSize));
    }

    private static void SetBounds(VisualElement element, Rect bounds)
    {
        element.style.position = Position.Absolute;
        element.style.left = bounds.x;
        element.style.top = bounds.y;
        element.style.width = bounds.width;
        element.style.height = bounds.height;
    }

    private void SetPauseMenuVisible(bool visible)
    {
        if (pauseMenu == null)
            return;

        pauseMenu.style.display = visible ? DisplayStyle.Flex : DisplayStyle.None;
    }

    private void SetButtonsInteractable(bool interactable)
    {
        if (pauseButton != null)
            pauseButton.SetEnabled(interactable);
        if (resumeButton != null)
            resumeButton.SetEnabled(interactable);
        if (mainMenuButton != null)
            mainMenuButton.SetEnabled(interactable);
    }

    private void GatePlayerInput()
    {
        if (ownsPlayerInputGate)
            return;

        ownsPlayerInputGate = true;
        playerInputWasEnabled = playerInput != null && playerInput.enabled;
        if (playerInputWasEnabled)
            playerInput.enabled = false;
    }

    private void RestorePlayerInput()
    {
        if (!ownsPlayerInputGate)
            return;

        if (playerInput != null && playerInputWasEnabled)
            playerInput.enabled = true;

        ownsPlayerInputGate = false;
        playerInputWasEnabled = false;
    }
}
