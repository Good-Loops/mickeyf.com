using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using ThreeBosses.Run;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static class RunOutcomeSceneBuilder
{
    private const string MainMenuPath = "Assets/Scenes/UI/MainMenu.unity";
    private const string LevelOnePath = "Assets/Scenes/Level1_BeeBoss.unity";
    private const string LevelTwoPath = "Assets/Scenes/Level2_CyborgBoss.unity";
    private const string LevelThreePath = "Assets/Scenes/Level3_Kraken.unity";

    private const string BeeTransitionPath = "Assets/Scenes/UI/Transition_BeeToCyborg.unity";
    private const string CyborgTransitionPath = "Assets/Scenes/UI/Transition_CyborgToKraken.unity";
    private const string BeeDefeatPath = "Assets/Scenes/UI/Defeat_Bee.unity";
    private const string CyborgDefeatPath = "Assets/Scenes/UI/Defeat_Cyborg.unity";
    private const string KrakenDefeatPath = "Assets/Scenes/UI/Defeat_Kraken.unity";
    private const string EndPath = "Assets/Scenes/UI/End.unity";

    private const string ScreenRoot = "Assets/Art/UI/Screens";
    private const string BossLoaderObjectName = "Phase12_BossOutcome";
    private const string PlayerLoaderObjectName = "Phase12_PlayerOutcome";
    private const string LevelEntryObjectName = "Phase12_LevelEntry";

    private static readonly Vector2 ArtReferenceResolution = new(1672f, 941f);

    [MenuItem("Three Bosses/Results/Build Transitions and Results")]
    public static void Build()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before building Phase 12 result scenes.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before building Phase 12 result scenes.");

        string originalPath = originalScene.path;

        try
        {
            BuildTransitionScene(
                BeeTransitionPath,
                $"{ScreenRoot}/Boss1Defeated.png",
                BossId.Cyborg,
                "Level2_CyborgBoss");
            BuildTransitionScene(
                CyborgTransitionPath,
                $"{ScreenRoot}/Boss2Defeated.png",
                BossId.Kraken,
                "Level3_Kraken");

            BuildDefeatScene(
                BeeDefeatPath,
                $"{ScreenRoot}/BeeDefeat.png",
                BossId.Bee,
                new Rect(535f, 580f, 605f, 72f),
                new Rect(368f, 751f, 432f, 110f),
                new Rect(874f, 751f, 424f, 110f),
                new Color(0.58f, 0.86f, 0f, 1f));
            BuildDefeatScene(
                CyborgDefeatPath,
                $"{ScreenRoot}/CyborgDefeat.png",
                BossId.Cyborg,
                new Rect(580f, 592f, 570f, 74f),
                new Rect(438f, 718f, 383f, 149f),
                new Rect(850f, 718f, 389f, 149f),
                new Color(1f, 0.12f, 0.08f, 1f));
            BuildDefeatScene(
                KrakenDefeatPath,
                $"{ScreenRoot}/KrakenDefeat.png",
                BossId.Kraken,
                new Rect(580f, 592f, 570f, 74f),
                new Rect(438f, 718f, 383f, 149f),
                new Rect(850f, 718f, 389f, 149f),
                new Color(0.68f, 0.24f, 1f, 1f));

            BuildEndScene();

            WireBattleScene(
                LevelOnePath,
                BossId.Bee,
                BeeTransitionPath,
                BeeDefeatPath,
                5f,
                3f,
                1f,
                false);
            WireBattleScene(
                LevelTwoPath,
                BossId.Cyborg,
                CyborgTransitionPath,
                CyborgDefeatPath,
                3f,
                2f,
                0.75f,
                true);
            WireBattleScene(
                LevelThreePath,
                BossId.Kraken,
                string.Empty,
                KrakenDefeatPath,
                1.25f,
                0.75f,
                0.5f,
                true);

            UpdateBuildSettings();
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("Phase 12 transition, defeat, and end scenes were built successfully.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalPath))
                EditorSceneManager.OpenScene(originalPath, OpenSceneMode.Single);
        }
    }

    private static void BuildTransitionScene(
        string scenePath,
        string spritePath,
        BossId expectedPendingBoss,
        string destinationSceneName)
    {
        Scene scene = CreateArtworkScene(spritePath, false, out _, out ScreenFade screenFade);

        GameObject controllerObject = new("Transition Controller");
        BossTransitionScreenController controller = controllerObject.AddComponent<BossTransitionScreenController>();
        SetEnum(controller, "expectedPendingBoss", expectedPendingBoss);
        SetString(controller, "destinationSceneName", destinationSceneName);
        SetObjectReference(controller, "screenFade", screenFade);

        SaveScene(scene, scenePath);
    }

    private static void BuildDefeatScene(
        string scenePath,
        string spritePath,
        BossId expectedBoss,
        Rect timeRect,
        Rect tryAgainRect,
        Rect menuRect,
        Color accent)
    {
        Scene scene = CreateArtworkScene(spritePath, true, out RectTransform artRoot, out ScreenFade screenFade);

        TMP_Text timeLabel = CreateText("Time Survived Value", artRoot, "00:00.000", 52f);
        SetTopLeftRect(timeLabel.rectTransform, timeRect);
        ConfigureValueText(timeLabel, accent);

        Button tryAgainButton = CreateButton("Try Again Button", artRoot, tryAgainRect, "TRY AGAIN", 32f, accent);
        Button backToMenuButton = CreateButton("Back To Menu Button", artRoot, menuRect, "BACK TO MENU", 30f, accent);

        GameObject controllerObject = new("Defeat Controller");
        DefeatScreenController controller = controllerObject.AddComponent<DefeatScreenController>();
        SetEnum(controller, "expectedBoss", expectedBoss);
        SetObjectReference(controller, "timeSurvivedLabel", timeLabel);
        SetObjectReference(controller, "tryAgainButton", tryAgainButton);
        SetObjectReference(controller, "backToMenuButton", backToMenuButton);
        SetObjectReference(controller, "screenFade", screenFade);

        SetFirstSelected(tryAgainButton.gameObject);
        SaveScene(scene, scenePath);
    }

    private static void BuildEndScene()
    {
        Scene scene = CreateArtworkScene(
            $"{ScreenRoot}/End.png",
            true,
            out RectTransform artRoot,
            out ScreenFade screenFade);

        TMP_Text timeLabel = CreateText("Completion Time Value", artRoot, "00:00.000", 46f);
        SetTopLeftRect(timeLabel.rectTransform, new Rect(397f, 690f, 300f, 78f));
        ConfigureValueText(timeLabel, Color.white);

        TMP_Text scoreLabel = CreateText("Score Value", artRoot, "0", 46f);
        SetTopLeftRect(scoreLabel.rectTransform, new Rect(710f, 690f, 258f, 78f));
        ConfigureValueText(scoreLabel, Color.white);

        TMP_Text rankLabel = CreateText("Rank Value", artRoot, "UNRANKED", 42f);
        SetTopLeftRect(rankLabel.rectTransform, new Rect(980f, 690f, 310f, 78f));
        ConfigureValueText(rankLabel, Color.white);

        Button tryAgainButton = CreateButton(
            "Try Again Button",
            artRoot,
            new Rect(285f, 812f, 365f, 103f),
            "TRY AGAIN",
            30f,
            new Color(0.58f, 0.86f, 0f, 1f));
        Button backToMenuButton = CreateButton(
            "Back To Menu Button",
            artRoot,
            new Rect(674f, 812f, 325f, 103f),
            "BACK TO MENU",
            27f,
            new Color(1f, 0.12f, 0.08f, 1f));
        Button submitButton = CreateButton(
            "Submit Score Button",
            artRoot,
            new Rect(1026f, 812f, 352f, 103f),
            "SUBMIT SCORE",
            25f,
            new Color(0.68f, 0.24f, 1f, 1f));
        submitButton.interactable = false;

        GameObject controllerObject = new("End Controller");
        EndScreenController controller = controllerObject.AddComponent<EndScreenController>();
        SetObjectReference(controller, "completionTimeLabel", timeLabel);
        SetObjectReference(controller, "scoreLabel", scoreLabel);
        SetObjectReference(controller, "rankLabel", rankLabel);
        SetObjectReference(controller, "tryAgainButton", tryAgainButton);
        SetObjectReference(controller, "backToMenuButton", backToMenuButton);
        SetObjectReference(controller, "submitScoreButton", submitButton);
        SetObjectReference(controller, "screenFade", screenFade);

        SetFirstSelected(tryAgainButton.gameObject);
        SaveScene(scene, EndPath);
    }

    private static Scene CreateArtworkScene(
        string spritePath,
        bool createEventSystem,
        out RectTransform artRoot,
        out ScreenFade screenFade)
    {
        Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(spritePath);
        if (sprite == null)
            throw new InvalidOperationException($"Screen sprite was not imported at {spritePath}.");

        Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        CreateCamera();

        if (createEventSystem)
            CreateEventSystem();

        Canvas canvas = CreateCanvas("Screen Canvas");
        Image backing = CreateImage("Black Backing", canvas.transform, Color.black);
        Stretch(backing.rectTransform);
        backing.raycastTarget = false;

        GameObject artRootObject = CreateUiObject("Art Root", canvas.transform);
        artRoot = artRootObject.GetComponent<RectTransform>();
        Stretch(artRoot);
        AspectRatioFitter aspect = artRootObject.AddComponent<AspectRatioFitter>();
        aspect.aspectMode = AspectRatioFitter.AspectMode.FitInParent;
        aspect.aspectRatio = ArtReferenceResolution.x / ArtReferenceResolution.y;

        Image background = CreateImage("Background", artRoot, Color.white);
        Stretch(background.rectTransform);
        background.sprite = sprite;
        background.type = Image.Type.Simple;
        background.preserveAspect = false;
        background.raycastTarget = false;

        Image fadeImage = CreateImage("Scene Fade", canvas.transform, Color.black);
        Stretch(fadeImage.rectTransform);
        fadeImage.raycastTarget = true;
        screenFade = fadeImage.gameObject.AddComponent<ScreenFade>();
        SetObjectReference(screenFade, "fadeImage", fadeImage);
        SetFloat(screenFade, "initialAlpha", 1f);

        return scene;
    }

    private static void WireBattleScene(
        string scenePath,
        BossId bossId,
        string transitionScenePath,
        string defeatScenePath,
        float bossLoadDelay,
        float bossFadeStartDelay,
        float bossFadeDuration,
        bool addLevelEntry)
    {
        Scene scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);

        HealthComponent bossHealth = FindBossHealth(scene, bossId);
        PlayerDeathHandler deathHandler = FindInScene<PlayerDeathHandler>(scene)
            ?? throw new InvalidOperationException($"{scene.name} is missing PlayerDeathHandler.");
        HealthComponent playerHealth = deathHandler.GetComponent<HealthComponent>()
            ?? GetObjectReference<HealthComponent>(deathHandler, "health")
            ?? throw new InvalidOperationException($"{scene.name} is missing player HealthComponent.");
        ScreenFade screenFade = FindInScene<ScreenFade>(scene)
            ?? throw new InvalidOperationException($"{scene.name} is missing ScreenFade.");

        BossDefeatSceneLoader bossLoader = FindInScene<BossDefeatSceneLoader>(scene);
        if (bossLoader == null)
            bossLoader = FindOrCreateRoot(scene, BossLoaderObjectName).AddComponent<BossDefeatSceneLoader>();

        SetObjectReference(bossLoader, "bossHealth", bossHealth);
        SetEnum(bossLoader, "bossId", bossId);
        SetString(bossLoader, "transitionSceneName", SceneNameFromPath(transitionScenePath));
        SetString(bossLoader, "endSceneName", "End");
        SetFloat(bossLoader, "loadDelaySeconds", bossLoadDelay);
        SetFloat(bossLoader, "fadeStartDelaySeconds", bossFadeStartDelay);
        SetFloat(bossLoader, "fadeDurationSeconds", bossFadeDuration);
        SetObjectReference(bossLoader, "screenFade", screenFade);

        GameObject playerOutcomeObject = FindOrCreateRoot(scene, PlayerLoaderObjectName);
        RunPlayerDefeatSceneLoader playerLoader = playerOutcomeObject.GetComponent<RunPlayerDefeatSceneLoader>()
            ?? playerOutcomeObject.AddComponent<RunPlayerDefeatSceneLoader>();
        SetObjectReference(playerLoader, "playerHealth", playerHealth);
        SetString(playerLoader, "defeatSceneName", SceneNameFromPath(defeatScenePath));
        SetObjectReference(playerLoader, "screenFade", screenFade);

        if (addLevelEntry)
        {
            GameObject entryObject = FindOrCreateRoot(scene, LevelEntryObjectName);
            RunLevelEntry entry = entryObject.GetComponent<RunLevelEntry>()
                ?? entryObject.AddComponent<RunLevelEntry>();
            SetEnum(entry, "bossId", bossId);
        }

        SaveScene(scene, scenePath);
    }

    private static HealthComponent FindBossHealth(Scene scene, BossId bossId)
    {
        Component controller = bossId switch
        {
            BossId.Bee => FindInScene<BossController>(scene),
            BossId.Cyborg => FindInScene<Boss2Controller>(scene),
            BossId.Kraken => FindInScene<Boss3Controller>(scene),
            _ => null
        };

        if (controller == null)
            throw new InvalidOperationException($"{scene.name} is missing its {bossId} controller.");

        return controller.GetComponent<HealthComponent>()
            ?? throw new InvalidOperationException($"{scene.name} boss is missing HealthComponent.");
    }

    private static T FindInScene<T>(Scene scene) where T : Component
    {
        return scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<T>(true))
            .FirstOrDefault();
    }

    private static GameObject FindOrCreateRoot(Scene scene, string name)
    {
        GameObject existing = scene.GetRootGameObjects().FirstOrDefault(root => root.name == name);
        if (existing != null)
            return existing;

        GameObject created = new(name);
        SceneManager.MoveGameObjectToScene(created, scene);
        return created;
    }

    private static void UpdateBuildSettings()
    {
        string[] orderedPaths =
        {
            MainMenuPath,
            LevelOnePath,
            BeeTransitionPath,
            LevelTwoPath,
            CyborgTransitionPath,
            LevelThreePath,
            BeeDefeatPath,
            CyborgDefeatPath,
            KrakenDefeatPath,
            EndPath
        };

        EditorBuildSettings.scenes = orderedPaths
            .Select(path => new EditorBuildSettingsScene(path, true))
            .ToArray();
    }

    private static string SceneNameFromPath(string scenePath)
    {
        return string.IsNullOrWhiteSpace(scenePath)
            ? string.Empty
            : System.IO.Path.GetFileNameWithoutExtension(scenePath);
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

    private static void CreateEventSystem()
    {
        new GameObject("EventSystem", typeof(EventSystem), typeof(InputSystemUIInputModule));
    }

    private static void SetFirstSelected(GameObject selectedObject)
    {
        EventSystem eventSystem = UnityEngine.Object.FindFirstObjectByType<EventSystem>();
        if (eventSystem == null)
            throw new InvalidOperationException("The generated interactive scene is missing its EventSystem.");

        eventSystem.firstSelectedGameObject = selectedObject;
    }

    private static Canvas CreateCanvas(string name)
    {
        GameObject canvasObject = new(name, typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        Canvas canvas = canvasObject.GetComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;

        CanvasScaler scaler = canvasObject.GetComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = ArtReferenceResolution;
        scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
        scaler.matchWidthOrHeight = 0.5f;
        return canvas;
    }

    private static Button CreateButton(
        string name,
        Transform parent,
        Rect rect,
        string labelValue,
        float fontSize,
        Color accent)
    {
        GameObject buttonObject = CreateUiObject(name, parent);
        RectTransform rectTransform = buttonObject.GetComponent<RectTransform>();
        SetTopLeftRect(rectTransform, rect);

        Image image = buttonObject.AddComponent<Image>();
        image.color = Color.white;
        image.raycastTarget = true;

        Button button = buttonObject.AddComponent<Button>();
        button.targetGraphic = image;
        button.transition = Selectable.Transition.ColorTint;
        ColorBlock colors = button.colors;
        colors.normalColor = new Color(accent.r, accent.g, accent.b, 0.03f);
        colors.highlightedColor = new Color(accent.r, accent.g, accent.b, 0.28f);
        colors.pressedColor = new Color(1f, 1f, 1f, 0.35f);
        colors.selectedColor = new Color(accent.r, accent.g, accent.b, 0.2f);
        colors.disabledColor = new Color(0.2f, 0.2f, 0.2f, 0.08f);
        colors.fadeDuration = 0.08f;
        button.colors = colors;

        TMP_Text label = CreateText("Label", rectTransform, labelValue, fontSize);
        Stretch(label.rectTransform);
        label.color = Color.white;
        label.fontStyle = FontStyles.Bold;
        label.alignment = TextAlignmentOptions.Center;
        label.textWrappingMode = TextWrappingModes.NoWrap;
        label.enableAutoSizing = true;
        label.fontSizeMin = Mathf.Max(16f, fontSize * 0.55f);
        label.fontSizeMax = fontSize;
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

    private static void ConfigureValueText(TMP_Text text, Color color)
    {
        text.color = color;
        text.fontStyle = FontStyles.Bold;
        text.alignment = TextAlignmentOptions.Center;
        text.textWrappingMode = TextWrappingModes.NoWrap;
        text.enableAutoSizing = true;
        text.fontSizeMin = 22f;
        text.fontSizeMax = text.fontSize;
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

    private static void SaveScene(Scene scene, string path)
    {
        if (!EditorSceneManager.SaveScene(scene, path))
            throw new InvalidOperationException($"Unity could not save {path}.");
    }

    private static T GetObjectReference<T>(UnityEngine.Object target, string propertyName)
        where T : UnityEngine.Object
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName);
        return property?.objectReferenceValue as T;
    }

    private static void SetObjectReference(
        UnityEngine.Object target,
        string propertyName,
        UnityEngine.Object value)
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

    private static void SetEnum(UnityEngine.Object target, string propertyName, BossId value)
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName)
            ?? throw new InvalidOperationException($"{target.GetType().Name} is missing {propertyName}.");
        property.intValue = (int)value;
        serializedObject.ApplyModifiedPropertiesWithoutUndo();
    }
}
