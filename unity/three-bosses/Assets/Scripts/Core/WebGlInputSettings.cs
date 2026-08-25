using UnityEngine;

/// <summary>
/// Lets keyboard focus leave the Unity canvas when WebGL is hosted by the website.
/// </summary>
public static class WebGlInputSettings
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void ConfigureKeyboardCapture()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        WebGLInput.captureAllKeyboardInput = false;
#endif
    }
}
