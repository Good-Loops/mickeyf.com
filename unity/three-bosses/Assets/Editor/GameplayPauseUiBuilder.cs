using System;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static class GameplayPauseUiBuilder
{
    private const string LevelOnePath = "Assets/Scenes/Level1_BeeBoss.unity";
    private const string LevelTwoPath = "Assets/Scenes/Level2_CyborgBoss.unity";
    private const string LevelThreePath = "Assets/Scenes/Level3_Kraken.unity";
    private const string RootObjectName = "Gameplay Pause UI";
    private const string FontAssetPath = "Assets/Art/UI/Fonts/Oxanium-Bold SDF.asset";

    private static readonly string[] BattleScenePaths =
    {
        LevelOnePath,
        LevelTwoPath,
        LevelThreePath,
    };

    private static readonly Color TextColor = new(0.9f, 0.96f, 1f, 1f);

    [MenuItem("Three Bosses/UI/Build Gameplay Pause Menus")]
    public static void Build()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before building gameplay pause menus.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before building gameplay pause menus.");

        string originalPath = originalScene.path;
        TMP_FontAsset font = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(FontAssetPath);
        if (font == null)
            throw new InvalidOperationException($"The pause-menu font is missing at {FontAssetPath}.");

        try
        {
            foreach (string scenePath in BattleScenePaths)
                BuildScene(scenePath, font);

            AssetDatabase.SaveAssets();
            Debug.Log("Gameplay pause menus were built successfully.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalPath))
                EditorSceneManager.OpenScene(originalPath, OpenSceneMode.Single);
        }
    }

    internal static void AddOrUpdatePauseUi(Scene scene, TMP_FontAsset font)
    {
        Canvas[] canvases = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<Canvas>(true))
            .Where(canvas => canvas.gameObject.name == "UI")
            .ToArray();
        if (canvases.Length != 1)
            throw new InvalidOperationException(
                $"{scene.name} must contain exactly one UI canvas; found {canvases.Length}.");

        Transform[] existingRoots = canvases[0].transform.Cast<Transform>()
            .Where(child => child.name == RootObjectName)
            .ToArray();
        if (existingRoots.Length > 1)
            throw new InvalidOperationException(
                $"{scene.name} contains duplicate {RootObjectName} objects.");

        PlayerInput[] playerInputs = scene.GetRootGameObjects()
            .SelectMany(rootObject => rootObject.GetComponentsInChildren<PlayerInput>(true))
            .ToArray();
        if (playerInputs.Length != 1)
            throw new InvalidOperationException(
                $"{scene.name} must contain exactly one PlayerInput; found {playerInputs.Length}.");

        GameObject root = existingRoots.Length == 1
            ? existingRoots[0].gameObject
            : CreateUiObject(RootObjectName, canvases[0].transform);
        Stretch(root.GetComponent<RectTransform>());
        root.transform.SetAsLastSibling();

        Button pauseButton = CreateGlassButton(
            "Pause Button",
            root.transform,
            new Vector2(1f, 1f),
            new Vector2(1f, 1f),
            new Vector2(-22f, -55f),
            new Vector2(48f, 48f),
            string.Empty,
            16f,
            font,
            PauseGlassGraphic.Style.PauseButton);
        RemoveChild(pauseButton.transform, "Pause Icon Left");
        RemoveChild(pauseButton.transform, "Pause Icon Right");

        GameObject overlayObject = CreateUiObject("Pause Menu", root.transform);
        RectTransform overlayRect = overlayObject.GetComponent<RectTransform>();
        Stretch(overlayRect);
        CanvasGroup pauseMenu = GetOrAddComponent<CanvasGroup>(overlayObject);
        pauseMenu.alpha = 0f;
        pauseMenu.interactable = false;
        pauseMenu.blocksRaycasts = false;

        Image dimmer = CreateImage(
            "Dimmer",
            overlayRect,
            new Color(0.005f, 0.012f, 0.02f, 0.34f));
        Stretch(dimmer.rectTransform);

        Image panel = CreateImage("Glass Panel", overlayRect, Color.clear);
        panel.raycastTarget = false;
        RemoveComponent<Outline>(panel.gameObject);
        RectTransform panelRect = panel.rectTransform;
        SetAnchoredRect(
            panelRect,
            new Vector2(0.5f, 0.5f),
            new Vector2(0.5f, 0.5f),
            Vector2.zero,
            new Vector2(360f, 238f));
        CreateGlassVisual(panel.transform, PauseGlassGraphic.Style.MenuPanel);

        TMP_Text title = CreateText("Paused Label", panelRect, "PAUSED", 38f, font);
        SetAnchoredRect(
            title.rectTransform,
            new Vector2(0.5f, 0.5f),
            new Vector2(0.5f, 0.5f),
            new Vector2(0f, 67f),
            new Vector2(300f, 56f));
        title.characterSpacing = 6f;

        Button resumeButton = CreateGlassButton(
            "Resume Button",
            panelRect,
            new Vector2(0.5f, 0.5f),
            new Vector2(0.5f, 0.5f),
            new Vector2(0f, 5f),
            new Vector2(240f, 50f),
            "RESUME",
            22f,
            font,
            PauseGlassGraphic.Style.ActionButton);

        Button mainMenuButton = CreateGlassButton(
            "Main Menu Button",
            panelRect,
            new Vector2(0.5f, 0.5f),
            new Vector2(0.5f, 0.5f),
            new Vector2(0f, -54f),
            new Vector2(240f, 50f),
            "MAIN MENU",
            19f,
            font,
            PauseGlassGraphic.Style.ActionButton);

        GameplayPauseController controller = GetOrAddComponent<GameplayPauseController>(root);
        SetObjectReference(controller, "pauseButton", pauseButton);
        SetObjectReference(controller, "pauseMenu", pauseMenu);
        SetObjectReference(controller, "resumeButton", resumeButton);
        SetObjectReference(controller, "mainMenuButton", mainMenuButton);
        SetObjectReference(controller, "playerInput", playerInputs[0]);
        SetString(controller, "mainMenuSceneName", "MainMenu");

        EditorUtility.SetDirty(controller);
        EditorUtility.SetDirty(root);
    }

    private static void BuildScene(string scenePath, TMP_FontAsset font)
    {
        Scene scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        AddOrUpdatePauseUi(scene, font);
        RestoreCanonicalCameraViewports(scene);

        if (!EditorSceneManager.SaveScene(scene, scenePath))
            throw new InvalidOperationException($"Unity could not save {scenePath}.");
    }

    private static void RestoreCanonicalCameraViewports(Scene scene)
    {
        // PixelPerfectCamera previews can write the current Game-view letterbox
        // rectangle into a scene while it is opened by an Editor builder. The
        // battle scenes own a full viewport, so keep that transient preview
        // state out of their serialized source.
        foreach (Camera camera in scene.GetRootGameObjects()
                     .SelectMany(root => root.GetComponentsInChildren<Camera>(true)))
        {
            camera.rect = new Rect(0f, 0f, 1f, 1f);
        }
    }

    private static GameObject CreateUiObject(string name, Transform parent)
    {
        Transform[] matches = parent.Cast<Transform>()
            .Where(child => child.name == name)
            .ToArray();
        if (matches.Length > 1)
            throw new InvalidOperationException(
                $"{parent.name} contains duplicate {name} objects.");

        GameObject gameObject = matches.Length == 1
            ? matches[0].gameObject
            : new GameObject(name, typeof(RectTransform));
        if (gameObject.transform.parent != parent)
            gameObject.transform.SetParent(parent, false);
        gameObject.layer = parent.gameObject.layer;
        return gameObject;
    }

    private static Image CreateImage(string name, Transform parent, Color color)
    {
        GameObject gameObject = CreateUiObject(name, parent);
        Image image = GetOrAddComponent<Image>(gameObject);
        image.color = color;
        image.raycastTarget = true;
        return image;
    }

    private static TMP_Text CreateText(
        string name,
        Transform parent,
        string value,
        float fontSize,
        TMP_FontAsset font)
    {
        GameObject gameObject = CreateUiObject(name, parent);
        TextMeshProUGUI label = GetOrAddComponent<TextMeshProUGUI>(gameObject);
        label.text = value;
        label.font = font;
        label.fontSharedMaterial = font.material;
        label.fontSize = fontSize;
        label.enableAutoSizing = false;
        label.fontStyle = FontStyles.Bold;
        label.alignment = TextAlignmentOptions.Center;
        label.textWrappingMode = TextWrappingModes.NoWrap;
        label.overflowMode = TextOverflowModes.Overflow;
        label.extraPadding = true;
        label.characterSpacing = 2f;
        label.color = TextColor;
        label.raycastTarget = false;
        return label;
    }

    private static Button CreateGlassButton(
        string name,
        Transform parent,
        Vector2 anchor,
        Vector2 pivot,
        Vector2 position,
        Vector2 size,
        string labelText,
        float fontSize,
        TMP_FontAsset font,
        PauseGlassGraphic.Style glassStyle)
    {
        Image background = CreateImage(name, parent, Color.clear);
        SetAnchoredRect(background.rectTransform, anchor, pivot, position, size);
        RemoveComponent<Outline>(background.gameObject);
        Vector2 visualInset = glassStyle == PauseGlassGraphic.Style.PauseButton
            ? new Vector2(3f, 3f)
            : new Vector2(10f, 3f);
        PauseGlassGraphic glass = CreateGlassVisual(
            background.transform,
            glassStyle,
            visualInset);

        Button button = GetOrAddComponent<Button>(background.gameObject);
        button.targetGraphic = glass;
        button.transition = Selectable.Transition.ColorTint;
        ColorBlock colors = button.colors;
        colors.normalColor = Color.white;
        colors.highlightedColor = new Color(0.78f, 0.95f, 1f, 1f);
        colors.selectedColor = new Color(0.82f, 0.97f, 1f, 1f);
        colors.pressedColor = new Color(0.55f, 0.86f, 0.9f, 1f);
        colors.disabledColor = new Color(0.45f, 0.5f, 0.54f, 0.52f);
        colors.colorMultiplier = 1f;
        colors.fadeDuration = 0.1f;
        button.colors = colors;

        TMP_Text label = CreateText("Label", background.transform, labelText, fontSize, font);
        Stretch(label.rectTransform);
        label.margin = new Vector4(10f, 2f, 10f, 2f);
        return button;
    }

    private static PauseGlassGraphic CreateGlassVisual(
        Transform parent,
        PauseGlassGraphic.Style style,
        Vector2 inset = default)
    {
        GameObject visualObject = CreateUiObject("Visual", parent);
        PauseGlassGraphic visual = GetOrAddComponent<PauseGlassGraphic>(visualObject);
        Stretch(visual.rectTransform, inset);
        visual.Configure(style);
        visualObject.transform.SetAsFirstSibling();
        return visual;
    }

    private static void RemoveChild(Transform parent, string name)
    {
        Transform child = parent.Find(name);
        if (child != null)
            UnityEngine.Object.DestroyImmediate(child.gameObject);
    }

    private static void RemoveComponent<T>(GameObject gameObject) where T : Component
    {
        T component = gameObject.GetComponent<T>();
        if (component != null)
            UnityEngine.Object.DestroyImmediate(component);
    }

    private static T GetOrAddComponent<T>(GameObject gameObject) where T : Component
    {
        T[] components = gameObject.GetComponents<T>();
        if (components.Length > 1)
            throw new InvalidOperationException(
                $"{gameObject.name} contains duplicate {typeof(T).Name} components.");

        return components.Length == 1 ? components[0] : gameObject.AddComponent<T>();
    }

    private static void Stretch(RectTransform rectTransform, Vector2 inset = default)
    {
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = Vector2.one;
        rectTransform.pivot = new Vector2(0.5f, 0.5f);
        rectTransform.offsetMin = inset;
        rectTransform.offsetMax = -inset;
        rectTransform.localScale = Vector3.one;
    }

    private static void SetAnchoredRect(
        RectTransform rectTransform,
        Vector2 anchor,
        Vector2 pivot,
        Vector2 position,
        Vector2 size)
    {
        rectTransform.anchorMin = anchor;
        rectTransform.anchorMax = anchor;
        rectTransform.pivot = pivot;
        rectTransform.anchoredPosition = position;
        rectTransform.sizeDelta = size;
        rectTransform.localScale = Vector3.one;
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
}
