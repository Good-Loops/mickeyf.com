using System;
using UnityEngine;

/// <summary>
/// Persists the player's single global audio preference across scenes and runs.
/// AudioListener.volume covers both SfxPlayer and scene-owned AudioSources.
/// </summary>
public static class GameAudioSettings
{
    private const string AudioEnabledKey = "three-bosses.audio-enabled";

    private static bool isLoaded;
    private static bool isEnabled;

    public static event Action<bool> Changed;

    public static bool IsEnabled
    {
        get
        {
            EnsureLoaded();
            return isEnabled;
        }
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics()
    {
        isLoaded = false;
        isEnabled = true;
        Changed = null;
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void ApplySavedPreference()
    {
        EnsureLoaded();
        ApplyVolume();
    }

    public static bool Toggle()
    {
        SetEnabled(!IsEnabled);
        return isEnabled;
    }

    public static void SetEnabled(bool enabled)
    {
        EnsureLoaded();

        if (isEnabled == enabled)
        {
            ApplyVolume();
            return;
        }

        isEnabled = enabled;
        PlayerPrefs.SetInt(AudioEnabledKey, enabled ? 1 : 0);
        PlayerPrefs.Save();
        ApplyVolume();
        Changed?.Invoke(isEnabled);
    }

    private static void EnsureLoaded()
    {
        if (isLoaded)
            return;

        isEnabled = PlayerPrefs.GetInt(AudioEnabledKey, 1) != 0;
        isLoaded = true;
    }

    private static void ApplyVolume()
    {
        AudioListener.volume = isEnabled ? 1f : 0f;
    }
}
