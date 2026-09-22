using System;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static class MainMenuAndCountdownBuilder
{
    private const string MenuScenePath = "Assets/Scenes/UI/MainMenu.unity";
    private const string LevelOneScenePath = "Assets/Scenes/Level1_BeeBoss.unity";
    private const string CountdownFontAssetPath = "Assets/Art/UI/Fonts/Oxanium-Bold SDF.asset";
    private const string CountdownObjectName = "Phase12_CountdownOverlay";
    private const string CountdownTextName = "Countdown Text";
    private const string CountdownDimmerName = "Dimmer";

    [MenuItem("Three Bosses/UI/Open Main Menu")]
    public static void OpenMainMenu()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before opening the Main Menu scene.");

        if (SceneManager.GetActiveScene().isDirty)
            throw new InvalidOperationException("Save the active scene before opening the Main Menu scene.");

        EditorSceneManager.OpenScene(MenuScenePath, OpenSceneMode.Single);
    }

    [MenuItem("Three Bosses/UI/Rebuild Level 1 Countdown")]
    public static void RebuildLevelOneCountdown()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before rebuilding the Level 1 countdown.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before rebuilding the Level 1 countdown.");

        string originalScenePath = originalScene.path;

        try
        {
            AddOrUpdateCountdownInLevelOne(LoadCountdownFont());
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("Level 1 countdown was rebuilt successfully.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalScenePath))
                EditorSceneManager.OpenScene(originalScenePath, OpenSceneMode.Single);
        }
    }

    private static void AddOrUpdateCountdownInLevelOne(TMP_FontAsset countdownFont)
    {
        Scene scene = EditorSceneManager.OpenScene(LevelOneScenePath, OpenSceneMode.Single);

        GameObject existingCountdown = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<Transform>(true))
            .Select(transform => transform.gameObject)
            .FirstOrDefault(gameObject => gameObject.name == CountdownObjectName);

        ScreenFade screenFade = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<ScreenFade>(true))
            .FirstOrDefault();
        if (screenFade == null)
            throw new InvalidOperationException("Level 1 is missing its expected ScreenFade component.");

        BossController bossController = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<BossController>(true))
            .FirstOrDefault();
        if (bossController == null)
            throw new InvalidOperationException("Level 1 is missing its expected BossController component.");

        TMP_Text countdownText;
        Image dimmer;
        RunCountdownController countdownController;

        if (existingCountdown != null)
        {
            countdownController = existingCountdown.GetComponent<RunCountdownController>();
            if (countdownController == null)
                throw new InvalidOperationException(
                    $"{CountdownObjectName} is missing its RunCountdownController component.");

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

            PlayerInput playerInput = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<PlayerInput>(true))
                .FirstOrDefault();

            PlayerWeaponController playerWeapon = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<PlayerWeaponController>(true))
                .FirstOrDefault();

            if (playerInput == null || playerWeapon == null)
                throw new InvalidOperationException(
                    "Level 1 must contain PlayerInput and PlayerWeaponController components.");

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

            countdownController = overlayObject.AddComponent<RunCountdownController>();
            SetObjectReference(countdownController, "countdownLabel", countdownText);
            SetObjectReference(countdownController, "canvasGroup", canvasGroup);
            SetObjectReference(countdownController, "screenFade", screenFade);
            SetObjectReference(countdownController, "playerInput", playerInput);
            SetObjectReference(countdownController, "playerWeapon", playerWeapon);

            EditorUtility.SetDirty(countdownController);
        }

        countdownController.transform.SetSiblingIndex(screenFade.transform.GetSiblingIndex() + 1);
        SetFloat(screenFade, "initialAlpha", 1f);
        SetObjectReference(countdownController, "bossController", bossController);
        SetObjectReference(countdownController, "dimmer", dimmer);
        ApplyCountdownPresentation(countdownText, dimmer, countdownFont);
        EditorUtility.SetDirty(screenFade);
        EditorUtility.SetDirty(countdownController);
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
        countdownText.text = "3";
        countdownText.color = Color.white;
        countdownText.fontSize = 220f;
        countdownText.fontSizeMin = 220f;
        countdownText.fontSizeMax = 220f;
        countdownText.fontStyle = FontStyles.Bold;
        countdownText.enableAutoSizing = false;
        countdownText.textWrappingMode = TextWrappingModes.NoWrap;
        countdownText.alignment = TextAlignmentOptions.Center;
        countdownText.extraPadding = true;
        countdownText.raycastTarget = false;
        countdownText.enableVertexGradient = true;
        Color threeTop = new Color32(215, 255, 105, 255);
        Color threeBottom = new Color32(130, 201, 0, 255);
        countdownText.colorGradient = new VertexGradient(
            threeTop,
            threeTop,
            threeBottom,
            threeBottom);
        countdownText.characterSpacing = 0f;
        countdownText.outlineColor = new Color32(5, 8, 13, 242);
        countdownText.outlineWidth = 0.12f;
        countdownText.alpha = 0f;
        countdownText.rectTransform.localScale = Vector3.one;

        Shadow[] shadows = countdownText.GetComponents<Shadow>();
        if (shadows.Length > 1)
            throw new InvalidOperationException(
                $"{CountdownTextName} has more than one Shadow component.");

        Shadow shadow = shadows.FirstOrDefault() ?? countdownText.gameObject.AddComponent<Shadow>();
        shadow.effectColor = new Color(0f, 0f, 0f, 0.68f);
        shadow.effectDistance = new Vector2(3f, -4f);
        shadow.useGraphicAlpha = true;

        dimmer.color = new Color(0f, 0f, 0f, 0.56f);
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

    private static void Stretch(RectTransform rectTransform)
    {
        rectTransform.anchorMin = Vector2.zero;
        rectTransform.anchorMax = Vector2.one;
        rectTransform.offsetMin = Vector2.zero;
        rectTransform.offsetMax = Vector2.zero;
    }

    private static void SetObjectReference(UnityEngine.Object target, string propertyName, UnityEngine.Object value)
    {
        SerializedObject serializedObject = new(target);
        SerializedProperty property = serializedObject.FindProperty(propertyName)
            ?? throw new InvalidOperationException($"{target.GetType().Name} is missing {propertyName}.");
        property.objectReferenceValue = value;
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
