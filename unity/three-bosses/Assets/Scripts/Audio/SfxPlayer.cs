using UnityEngine;

/// <summary>
/// Plays non-looping, two-dimensional game sound effects.
/// One AudioSource can overlap multiple sounds through PlayOneShot.
/// </summary>
public static class SfxPlayer
{
    private static AudioSource audioSource;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics()
    {
        audioSource = null;
    }

    public static void PlayOneShot(AudioClip clip, float volume = 1f)
    {
        if (clip == null)
            return;

        EnsureAudioSource();

        audioSource.PlayOneShot(clip, Mathf.Clamp01(volume));
    }

    private static void EnsureAudioSource()
    {
        if (audioSource != null)
            return;

        var audioObject = new GameObject("SFX Player");
        Object.DontDestroyOnLoad(audioObject);

        audioSource = audioObject.AddComponent<AudioSource>();
        audioSource.playOnAwake = false;
        audioSource.loop = false;
        audioSource.spatialBlend = 0f;
    }
}
