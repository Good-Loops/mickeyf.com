using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static class MainMenuAndCountdownBuilder
{
    private const string MenuScenePath = "Assets/Scenes/UI/MainMenu.unity";
    private const string LevelOneScenePath = "Assets/Scenes/Level1_BeeBoss.unity";
    private const string MenuSpritePath = "Assets/Art/UI/Screens/Menu.png";
    private const string CountdownFontAssetPath = "Assets/Art/UI/Fonts/Oxanium-Bold SDF.asset";
    private const string CountdownObjectName = "Phase12_CountdownOverlay";
    private const string CountdownTextName = "Countdown Text";
    private const string CountdownDimmerName = "Dimmer";

    private static readonly Vector2 ArtReferenceResolution = new(1672f, 941f);

    [MenuItem("Three Bosses/UI/Build Main Menu and Countdown")]
    public static void Build()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before building the Main Menu and Level 1 countdown.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before building the Main Menu and Level 1 countdown.");

        string originalScenePath = originalScene.path;

        try
        {
            TMP_FontAsset countdownFont = LoadCountdownFont();
            EnsureAssetFolder("Assets/Scenes/UI");
            BuildMainMenuScene();
            AddOrUpdateCountdownInLevelOne(countdownFont);
            UpdateBuildSettings();
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("Main Menu and Level 1 countdown were built successfully.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalScenePath))
                EditorSceneManager.OpenScene(originalScenePath, OpenSceneMode.Single);
        }
    }

    [MenuItem("Three Bosses/UI/Open Main Menu")]
    public static void OpenMainMenu()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before opening the Main Menu scene.");

        if (SceneManager.GetActiveScene().isDirty)
            throw new InvalidOperationException("Save the active scene before opening the Main Menu scene.");

        EditorSceneManager.OpenScene(MenuScenePath, OpenSceneMode.Single);
    }

    [MenuItem("Three Bosses/UI/Rebuild Main Menu")]
    public static void RebuildMainMenu()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before rebuilding the Main Menu scene.");

        if (SceneManager.GetActiveScene().isDirty)
            throw new InvalidOperationException("Save the active scene before rebuilding the Main Menu scene.");

        EnsureAssetFolder("Assets/Scenes/UI");
        BuildMainMenuScene();
        UpdateBuildSettings();
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log("Main Menu was rebuilt successfully.");
    }

    private static void BuildMainMenuScene()
    {
        Sprite menuSprite = AssetDatabase.LoadAssetAtPath<Sprite>(MenuSpritePath);
        if (menuSprite == null)
            throw new InvalidOperationException($"Menu sprite was not imported at {MenuSpritePath}.");

        Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        CreateCamera();
        EventSystem eventSystem = CreateEventSystem();
        Canvas canvas = CreateCanvas("Menu Canvas", ArtReferenceResolution, 0);

        Image blackBacking = CreateImage("Black Backing", canvas.transform, Color.black);
        Stretch(blackBacking.rectTransform);
        blackBacking.raycastTarget = false;

        GameObject artRootObject = CreateUiObject("Art Root", canvas.transform);
        RectTransform artRoot = artRootObject.GetComponent<RectTransform>();
        Stretch(artRoot);

        AspectRatioFitter aspectFitter = artRootObject.AddComponent<AspectRatioFitter>();
        aspectFitter.aspectMode = AspectRatioFitter.AspectMode.FitInParent;
        aspectFitter.aspectRatio = ArtReferenceResolution.x / ArtReferenceResolution.y;

        Image background = CreateImage("Background", artRoot, Color.white);
        Stretch(background.rectTransform);
        background.sprite = menuSprite;
        background.type = Image.Type.Simple;
        background.preserveAspect = false;
        background.raycastTarget = false;

        Button playButton = CreateButton(
            "Play Button",
            artRoot,
            new Rect(590f, 735f, 490f, 125f),
            "PLAY",
            58f);

        Button audioButton = CreateButton(
            "Audio Button",
            artRoot,
            new Rect(1472f, 76f, 142f, 78f),
            "AUDIO ON",
            18f);

        TMP_Text audioLabel = audioButton.GetComponentInChildren<TMP_Text>(true);

        Image fadeImage = CreateImage("Scene Fade", canvas.transform, new Color(0f, 0f, 0f, 0f));
        Stretch(fadeImage.rectTransform);
        fadeImage.raycastTarget = false;
        ScreenFade screenFade = fadeImage.gameObject.AddComponent<ScreenFade>();
        SetObjectReference(screenFade, "fadeImage", fadeImage);
        SetFloat(screenFade, "initialAlpha", 0f);

        GameObject controllerObject = new("Main Menu Controller");
        MainMenuController controller = controllerObject.AddComponent<MainMenuController>();
        SetObjectReference(controller, "playButton", playButton);
        SetObjectReference(controller, "audioButton", audioButton);
        SetObjectReference(controller, "audioButtonLabel", audioLabel);
        SetObjectReference(controller, "screenFade", screenFade);
        SetString(controller, "firstLevelSceneName", "Level1_BeeBoss");

        eventSystem.firstSelectedGameObject = playButton.gameObject;

        if (!EditorSceneManager.SaveScene(scene, MenuScenePath))
            throw new InvalidOperationException($"Unity could not save {MenuScenePath}.");
    }

    private static void AddOrUpdateCountdownInLevelOne(TMP_FontAsset countdownFont)
    {
        Scene scene = EditorSceneManager.OpenScene(LevelOneScenePath, OpenSceneMode.Single);

        GameObject existingCountdown = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<Transform>(true))
            .Select(transform => transform.gameObject)
            .FirstOrDefault(gameObject => gameObject.name == CountdownObjectName);

        TMP_Text countdownText;
        Image dimmer;

        if (existingCountdown != null)
        {
            countdownText = existingCountdown.GetComponentsInChildren<TMP_Text>(true)
                .FirstOrDefault(candidate => candidate.gameObject.name == CountdownTextName);
            if (countdownText == null)
                throw new InvalidOperationException(
                    $"{CountdownObjectName} is missing its expected {CountdownTextName} object.");

            dimmer = existingCountdown.GetComponentsInChildren<Image>(true)
                .FirstOrDefault(candidate => candidate.gameObject.name == CountdownDimmerName);
            if (dimmer == null)
                throw new InvalidOperationException(
                    $"{CountdownObjectName} is missing its expected {CountdownDimmerName} object.");

            Debug.Log("Level 1 countdown already exists; updating its presentation and preserving its scene wiring.");
        }
        else
        {
            Canvas uiCanvas = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<Canvas>(true))
                .FirstOrDefault(candidate => candidate.gameObject.name == "UI");

            if (uiCanvas == null)
                throw new InvalidOperationException("Level 1 is missing its expected UI Canvas.");

            ScreenFade screenFade = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<ScreenFade>(true))
                .FirstOrDefault();

            PlayerInput playerInput = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<PlayerInput>(true))
                .FirstOrDefault();

            PlayerWeaponController playerWeapon = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<PlayerWeaponController>(true))
                .FirstOrDefault();

            if (screenFade == null || playerInput == null || playerWeapon == null)
                throw new InvalidOperationException(
                    "Level 1 must contain ScreenFade, PlayerInput, and PlayerWeaponController components.");

            GameObject overlayObject = CreateUiObject(CountdownObjectName, uiCanvas.transform);
            RectTransform overlayRect = overlayObject.GetComponent<RectTransform>();
            Stretch(overlayRect);

            CanvasGroup canvasGroup = overlayObject.AddComponent<CanvasGroup>();
            canvasGroup.alpha = 1f;
            canvasGroup.interactable = false;
            canvasGroup.blocksRaycasts = true;

            dimmer = CreateImage(CountdownDimmerName, overlayRect, new Color(0f, 0f, 0f, 0.55f));
            Stretch(dimmer.rectTransform);
            dimmer.raycastTarget = true;

            countdownText = CreateText(CountdownTextName, overlayRect, "3", 180f);
            Stretch(countdownText.rectTransform);
            countdownText.color = Color.white;

            RunCountdownController countdownController = overlayObject.AddComponent<RunCountdownController>();
            SetObjectReference(countdownController, "countdownLabel", countdownText);
            SetObjectReference(countdownController, "canvasGroup", canvasGroup);
            SetObjectReference(countdownController, "screenFade", screenFade);
            SetObjectReference(countdownController, "playerInput", playerInput);
            SetObjectReference(countdownController, "playerWeapon", playerWeapon);

            overlayRect.SetSiblingIndex(screenFade.transform.GetSiblingIndex());
            SetFloat(screenFade, "initialAlpha", 1f);

            EditorUtility.SetDirty(screenFade);
            EditorUtility.SetDirty(countdownController);
        }

        ApplyCountdownPresentation(countdownText, dimmer, countdownFont);
        EditorUtility.SetDirty(countdownText);
        EditorUtility.SetDirty(dimmer);

        if (!EditorSceneManager.SaveScene(scene, LevelOneScenePath))
            throw new InvalidOperationException($"Unity could not save {LevelOneScenePath}.");
    }

    private static TMP_FontAsset LoadCountdownFont()
    {
        TMP_FontAsset countdownFont =
            AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(CountdownFontAssetPath);

        if (countdownFont == null)
            throw new InvalidOperationException(
                $"The committed countdown font asset is missing at {CountdownFontAssetPath}.");

        return countdownFont;
    }

    private static void ApplyCountdownPresentation(
        TMP_Text countdownText,
        Image dimmer,
        TMP_FontAsset countdownFont)
    {
        countdownText.font = countdownFont;
        countdownText.fontSize = 220f;
        countdownText.fontSizeMin = 96f;
        countdownText.fontSizeMax = 220f;
        countdownText.fontStyle = FontStyles.Bold;
        countdownText.enableAutoSizing = true;
        countdownText.textWrappingMode = TextWrappingModes.NoWrap;
        countdownText.alignment = TextAlignmentOptions.Center;
        countdownText.extraPadding = true;
        countdownText.raycastTarget = false;

        dimmer.color = new Color(0f, 0f, 0f, 0.62f);
    }

    private static void UpdateBuildSettings()
    {
        var scenes = new List<EditorBuildSettingsScene>
        {
            new(MenuScenePath, true)
        };

        scenes.AddRange(EditorBuildSettings.scenes.Where(scene => scene.path != MenuScenePath));
        EditorBuildSettings.scenes = scenes.ToArray();
    }

    private static void CreateCamera()
    {
        GameObject cameraObject = new("Main Camera", typeof(Camera), typeof(AudioListener));
        cameraObject.tag = "MainCamera";
        Camera camera = cameraObject.GetComponent<Camera>();
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = Color.black;
        camera.orthographic = true;
        cameraObject.transform.position = new Vector3(0f, 0f, -10f);
    }

    private static EventSystem CreateEventSystem()
    {
        GameObject eventSystemObject = new("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
        return eventSystemObject.GetComponent<EventSystem>();
    }

    private static Canvas CreateCanvas(string name, Vector2 referenceResolution, int sortingOrder)
    {
        GameObject canvasObject = new(name, typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        Canvas canvas = canvasObject.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = sortingOrder;

        CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = referenceResolution;
        scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight = 0.5f;

        return canvas;
    }

    private static Button CreateButton(
        string name,
        Transform parent,
        Rect topLeftRect,
        string labelText,
        float fontSize)
    {
        GameObject buttonObject = CreateUiObject(name, parent);
        RectTransform rectTransform = buttonObject.GetComponent<RectTransform>();
        SetTopLeftRect(rectTransform, topLeftRect);

        Image image = buttonObject.AddComponent<Image>();
        image.color = Color.white;
        image.raycastTarget = true;

        Button button = buttonObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.transition = Selectable.Transition.ColorTint;

        ColorBlock colors = button.colors;
        colors.normalColor = new Color(0.35f, 0f, 0f, 0.08f);
        colors.highlightedColor = new Color(1f, 0.12f, 0.08f, 0.32f);
        colors.pressedColor = new Color(1f, 0.85f, 0.8f, 0.4f);
        colors.selectedColor = new Color(1f, 0.12f, 0.08f, 0.24f);
        colors.disabledColor = new Color(0.2f, 0.2f, 0.2f, 0.1f);
        colors.colorMultiplier = 1f;
        colors.fadeDuration = 0.08f;
        button.colors = colors;

        TMP_Text label = CreateText("Label", rectTransform, labelText, fontSize);
        Stretch(label.rectTransform);
        label.color = Color.white;
        label.fontStyle = FontStyles.Bold;
        label.alignment = TextAlignmentOptions.Center;
        label.textWrappingMode = TextWrappingModes.NoWrap;
        label.enableAutoSizing = true;
        label.fontSizeMin = Mathf.Max(12f, fontSize * 0.5f);
        label.fontSizeMax = fontSize;
        label.raycastTarget = false;

        return button;
    }

    private static TMP_Text CreateText(string name, Transform parent, string value, float fontSize)
    {
        GameObject textObject = CreateUiObject(name, parent);
        TextMeshProUGUI text = textObject.AddComponent<TextMeshProUGUI>();
        text.text = value;
        text.font = TMP_Settings.defaultFontAsset;
        text.fontSize = fontSize;
        text.raycastTarget = false;
        return text;
    }

    private static Image CreateImage(string name, Transform parent, Color color)
    {
        GameObject imageObject = CreateUiObject(name, parent);
        Image image = imageObject.AddComponent<Image>();
        image.color = color;
        return image;
    }

    private static GameObject CreateUiObject(string name, Transform parent)
    {
        GameObject gameObject = new(name, typeof(RectTransform));
        gameObject.transform.SetParent(parent, false);
        return gameObject;
    }

    private static void SetTopLeftRect(RectTransform rectTransform, Rect rect)
    {
        rectTransform.anchorMin = new Vector2(0f, 1f);
        rectTransform.anchorMax = new Vector2(0f, 1f);
        rectTransform.pivot = new Vector2(0f, 1f);
        rectTransform.anchoredPosition = new Vector2(rect.x, -rect.y);
        rectTransform.sizeDelta = new Vector2(rect.width, rect.height);
    }

    private static void Stretch(RectTransform rectTransform)
    {
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = Vector2.one;
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = Vector2.zero;
    }

    private static void EnsureAssetFolder(string assetPath)
    {
        string[] segments = assetPath.Split('/');
        string current = segments[0];

        for (int index = 1; index < segments.Length; index++)
        {
            string next = $"{current}/{segments[index]}";
            if (!AssetDatabase.IsValidFolder(next))
                AssetDatabase.CreateFolder(current, segments[index]);

            current = next;
        }
    }

    private static void SetObjectReference(UnityEngine.Object target, string propertyName, UnityEngine.Object value)
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName)
            ?? throw new InvalidOperationException($"{target.GetType().Name} is missing {propertyName}.");
        property.objectReferenceValue = value;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
    }

    private static void SetString(UnityEngine.Object target, string propertyName, string value)
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName)
            ?? throw new InvalidOperationException($"{target.GetType().Name} is missing {propertyName}.");
        property.stringValue = value;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
    }

    private static void SetFloat(UnityEngine.Object target, string propertyName, float value)
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName)
            ?? throw new InvalidOperationException($"{target.GetType().Name} is missing {propertyName}.");
        property.floatValue = value;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
    }
}
