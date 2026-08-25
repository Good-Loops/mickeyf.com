using System;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static class RunTimerDisplayBuilder
{
    private const string LevelOnePath = "Assets/Scenes/Level1_BeeBoss.unity";
    private const string LevelTwoPath = "Assets/Scenes/Level2_CyborgBoss.unity";
    private const string LevelThreePath = "Assets/Scenes/Level3_Kraken.unity";
    private const string TimerObjectName = "Phase12_RunTimer";
    private const string TimerFontAssetPath = "Assets/Art/UI/Fonts/Oxanium-Bold Timer SDF.asset";

    private static readonly Vector2 TimerAnchor = new(0.5f, 1f);
    private static readonly Vector2 TimerPosition = new(0f, -2f);
    private static readonly Vector2 TimerSize = new(210f, 24f);
    private static readonly Color TimerTopColor = new(0.9725f, 0.9922f, 1f, 1f);
    private static readonly Color TimerBottomColor = new(0.5608f, 0.851f, 0.9686f, 1f);

    [MenuItem("Three Bosses/UI/Build Run Timer Displays")]
    public static void Build()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before building the run timer displays.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before building the run timer displays.");

        string originalPath = originalScene.path;

        try
        {
            BuildScene(LevelOnePath);
            BuildScene(LevelTwoPath);
            BuildScene(LevelThreePath);
            AssetDatabase.SaveAssets();
            Debug.Log("Run timer displays were built successfully.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalPath))
                EditorSceneManager.OpenScene(originalPath, OpenSceneMode.Single);
        }
    }

    internal static void AddOrUpdateRunTimer(Scene scene)
    {
        Canvas[] canvases = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<Canvas>(true))
            .Where(canvas => canvas.gameObject.name == "UI")
            .ToArray();

        if (canvases.Length != 1)
            throw new InvalidOperationException(
                $"{scene.name} must contain exactly one UI canvas; found {canvases.Length}.");

        Canvas canvas = canvases[0];
        Transform[] namedTimers = canvas.transform.Cast<Transform>()
            .Where(child => child.name == TimerObjectName)
            .ToArray();

        if (namedTimers.Length > 1)
            throw new InvalidOperationException(
                $"{scene.name} contains duplicate {TimerObjectName} objects.");

        RunTimerDisplay[] displays = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<RunTimerDisplay>(true))
            .ToArray();

        if (displays.Length > 1)
            throw new InvalidOperationException(
                $"{scene.name} contains multiple RunTimerDisplay components.");

        GameObject timerObject;
        if (namedTimers.Length == 1)
        {
            timerObject = namedTimers[0].gameObject;
            if (displays.Length == 1 && displays[0].gameObject != timerObject)
                throw new InvalidOperationException(
                    $"{scene.name} has conflicting named and component-based timer objects.");
        }
        else if (displays.Length == 1)
        {
            timerObject = displays[0].gameObject;
            timerObject.name = TimerObjectName;
            timerObject.transform.SetParent(canvas.transform, false);
        }
        else
        {
            timerObject = new GameObject(TimerObjectName, typeof(RectTransform));
            timerObject.transform.SetParent(canvas.transform, false);
        }

        timerObject.layer = canvas.gameObject.layer;

        RectTransform rectTransform = timerObject.GetComponent<RectTransform>()
            ?? throw new InvalidOperationException($"{TimerObjectName} is missing its RectTransform.");
        rectTransform.anchorMin = TimerAnchor;
        rectTransform.anchorMax = TimerAnchor;
        rectTransform.pivot = TimerAnchor;
        rectTransform.anchoredPosition = TimerPosition;
        rectTransform.sizeDelta = TimerSize;
        rectTransform.localScale = Vector3.one;

        TextMeshProUGUI label = timerObject.GetComponent<TextMeshProUGUI>()
            ?? timerObject.AddComponent<TextMeshProUGUI>();
        TMP_FontAsset timerFont = AssetDatabase.LoadAssetAtPath<TMP_FontAsset>(TimerFontAssetPath);
        if (timerFont == null)
            throw new InvalidOperationException(
                $"The committed timer font asset is missing at {TimerFontAssetPath}.");

        string timerCharacters = RunUiFormatter.FormatTime(0d);
        if (!timerFont.HasCharacters(timerCharacters))
            throw new InvalidOperationException(
                $"The timer font is missing characters required by {timerCharacters}.");

        label.text = RunUiFormatter.FormatTime(0d);
        label.font = timerFont;
        ClearInstancedFontMaterial(label);
        label.fontSharedMaterial = timerFont.material;
        label.fontSize = 22f;
        label.enableAutoSizing = false;
        label.fontStyle = FontStyles.Normal;
        label.alignment = TextAlignmentOptions.Center;
        label.textWrappingMode = TextWrappingModes.NoWrap;
        label.overflowMode = TextOverflowModes.Overflow;
        label.extraPadding = true;
        label.characterSpacing = 2f;
        label.raycastTarget = false;
        label.color = Color.white;
        label.enableVertexGradient = true;
        label.colorGradient = new VertexGradient(
            TimerTopColor,
            TimerTopColor,
            TimerBottomColor,
            TimerBottomColor);
        label.outlineColor = new Color32(5, 8, 13, 230);
        label.outlineWidth = 0.08f;
        label.margin = new Vector4(4f, 0f, 4f, 0f);

        RunTimerDisplay display = timerObject.GetComponent<RunTimerDisplay>()
            ?? timerObject.AddComponent<RunTimerDisplay>();
        SetObjectReference(display, "timerLabel", label);

        Transform playerHealthBar = canvas.transform.Find("PlayerHealthBar")
            ?? throw new InvalidOperationException($"{scene.name} is missing PlayerHealthBar.");
        Transform bossHealthBar = canvas.transform.Find("BossHealthBar")
            ?? throw new InvalidOperationException($"{scene.name} is missing BossHealthBar.");
        int timerSiblingIndex = Mathf.Max(
            playerHealthBar.GetSiblingIndex(),
            bossHealthBar.GetSiblingIndex()) + 1;
        timerObject.transform.SetSiblingIndex(timerSiblingIndex);

        EditorUtility.SetDirty(label);
        EditorUtility.SetDirty(display);
    }

    private static void ClearInstancedFontMaterial(TextMeshProUGUI label)
    {
        SerializedObject serializedLabel = new(label);
        SerializedProperty fontMaterial = serializedLabel.FindProperty("m_fontMaterial")
            ?? throw new InvalidOperationException("TextMeshProUGUI is missing m_fontMaterial.");
        fontMaterial.objectReferenceValue = null;
        serializedLabel.ApplyModifiedPropertiesWithoutUndo();
    }

    private static void BuildScene(string scenePath)
    {
        Scene scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        AddOrUpdateRunTimer(scene);

        if (!EditorSceneManager.SaveScene(scene, scenePath))
            throw new InvalidOperationException($"Unity could not save {scenePath}.");
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
}
