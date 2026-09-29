using System;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

internal static class EditorSceneWorkspace
{
    public static void RequireSavedScenes(string operation)
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode)
            throw new InvalidOperationException($"Exit Play Mode before {operation}.");

        // Opening a scene in Single mode closes additive scenes too.
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            if (SceneManager.GetSceneAt(i).isDirty)
                throw new InvalidOperationException($"Save all open scenes before {operation}.");
        }
    }

    public static void RunWithRestoredScenes(string operation, Action build)
    {
        RequireSavedScenes(operation);
        SceneSetup[] originalSetup = EditorSceneManager.GetSceneManagerSetup();
        if (originalSetup.Length == 0 ||
            Array.Exists(originalSetup, scene => string.IsNullOrEmpty(scene.path)))
            throw new InvalidOperationException($"Save all open scenes before {operation}.");

        try
        {
            build();
        }
        finally
        {
            EditorSceneManager.RestoreSceneManagerSetup(originalSetup);
        }
    }
}
