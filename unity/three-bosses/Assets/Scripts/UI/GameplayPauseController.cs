using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

/// <summary>
/// Owns the player-requested pause UI in battle scenes. The persistent run
/// service composes this pause reason with browser visibility suspension.
/// </summary>
public sealed class GameplayPauseController : MonoBehaviour
{
    [SerializeField] private Button pauseButton;
    [SerializeField] private CanvasGroup pauseMenu;
    [SerializeField] private Button resumeButton;
    [SerializeField] private Button mainMenuButton;
    [SerializeField] private PlayerInput playerInput;
    [SerializeField] private string mainMenuSceneName = "MainMenu";

    private RunSessionService runSessionService;
    private bool isNavigating;
    private bool ownsPlayerInputGate;
    private bool playerInputWasEnabled;

    private void Awake()
    {
        SetPauseMenuVisible(false);
    }

    private void OnEnable()
    {
        runSessionService = RunSessionService.Instance;
        pauseButton?.onClick.AddListener(TogglePause);
        resumeButton?.onClick.AddListener(ResumeGameplay);
        mainMenuButton?.onClick.AddListener(ReturnToMainMenu);
        RefreshPauseButton();
    }

    private void Update()
    {
        RefreshPauseButton();

        if (!isNavigating && Keyboard.current?.escapeKey.wasPressedThisFrame == true)
            TogglePause();
    }

    private void OnDisable()
    {
        pauseButton?.onClick.RemoveListener(TogglePause);
        resumeButton?.onClick.RemoveListener(ResumeGameplay);
        mainMenuButton?.onClick.RemoveListener(ReturnToMainMenu);

        runSessionService?.ResumeFromUserPause();
        RestorePlayerInput();
        runSessionService = null;
        isNavigating = false;
        SetPauseMenuVisible(false);
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
        EventSystem.current?.SetSelectedGameObject(resumeButton?.gameObject);
    }

    public void ResumeGameplay()
    {
        if (isNavigating || runSessionService == null)
            return;

        runSessionService.ResumeFromUserPause();
        RestorePlayerInput();
        SetPauseMenuVisible(false);
        RefreshPauseButton();
        EventSystem.current?.SetSelectedGameObject(pauseButton?.gameObject);
    }

    public void ReturnToMainMenu()
    {
        if (isNavigating || string.IsNullOrWhiteSpace(mainMenuSceneName))
            return;

        isNavigating = true;
        runSessionService?.ResumeFromUserPause();
        RestorePlayerInput();
        SetButtonsInteractable(false);
        SceneManager.LoadScene(mainMenuSceneName);
    }

    private void RefreshPauseButton()
    {
        if (pauseButton == null)
            return;

        bool shouldShow = !isNavigating &&
                          runSessionService != null &&
                          runSessionService.CanPauseByUser;
        if (pauseButton.gameObject.activeSelf != shouldShow)
            pauseButton.gameObject.SetActive(shouldShow);
    }

    private void SetPauseMenuVisible(bool visible)
    {
        if (pauseMenu == null)
            return;

        pauseMenu.alpha = visible ? 1f : 0f;
        pauseMenu.interactable = visible;
        pauseMenu.blocksRaycasts = visible;
    }

    private void SetButtonsInteractable(bool interactable)
    {
        if (pauseButton != null)
            pauseButton.interactable = interactable;
        if (resumeButton != null)
            resumeButton.interactable = interactable;
        if (mainMenuButton != null)
            mainMenuButton.interactable = interactable;
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
