using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static class UiButtonPresentationBuilder
{
    private static readonly IReadOnlyDictionary<string, int> SceneButtonCounts =
        new Dictionary<string, int>
        {
            ["Assets/Scenes/UI/MainMenu.unity"] = 2,
            ["Assets/Scenes/UI/Defeat_Bee.unity"] = 2,
            ["Assets/Scenes/UI/Defeat_Cyborg.unity"] = 2,
            ["Assets/Scenes/UI/Defeat_Kraken.unity"] = 2,
            ["Assets/Scenes/UI/End.unity"] = 3
        };

    [MenuItem("Three Bosses/UI/Refresh Button Presentation")]
    public static void RefreshButtonPresentation()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException("Exit Play Mode before refreshing button presentation.");

        Scene originalScene = SceneManager.GetActiveScene();
        if (originalScene.isDirty)
            throw new InvalidOperationException("Save the active scene before refreshing button presentation.");

        string originalScenePath = originalScene.path;

        try
        {
            foreach (KeyValuePair<string, int> sceneEntry in SceneButtonCounts)
                RefreshScene(sceneEntry.Key, sceneEntry.Value);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("Button presentation was refreshed in all interactive UI scenes.");
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(originalScenePath))
                EditorSceneManager.OpenScene(originalScenePath, OpenSceneMode.Single);
        }
    }

    private static void RefreshScene(string scenePath, int expectedButtonCount)
    {
        Scene scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        Button[] buttons = scene.GetRootGameObjects()
            .SelectMany(root => root.GetComponentsInChildren<Button>(true))
            .ToArray();

        if (buttons.Length != expectedButtonCount)
            throw new InvalidOperationException(
                $"{scene.name} has {buttons.Length} buttons; expected {expectedButtonCount}.");

        foreach (Button button in buttons)
        {
            if (scene.name == "MainMenu" && button.name == "Audio Button")
            {
                AudioToggleIcon icon = button.GetComponentInChildren<AudioToggleIcon>(true)
                    ?? throw new InvalidOperationException(
                        $"{button.name} in {scene.name} is missing its audio icon.");
                UiButtonStyle.ApplyToGraphic(button, icon);
            }
            else
            {
                if (button.GetComponentInChildren<TMP_Text>(true) == null)
                    throw new InvalidOperationException(
                        $"{button.name} in {scene.name} is missing its label.");

                UiButtonStyle.Apply(button);
            }

            EditorUtility.SetDirty(button);
        }

        if (!EditorSceneManager.SaveScene(scene, scenePath))
            throw new InvalidOperationException($"Unity could not save {scenePath}.");
    }
}
