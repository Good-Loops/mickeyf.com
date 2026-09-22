#if UNITY_EDITOR
using System;
using System.Collections;
using System.IO;
using System.Reflection;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace ThreeBosses.Tests
{
    public sealed class MainMenuToolkitPilotTests
    {
        private const string PilotScene = "Assets/Scenes/UI/MainMenuToolkitPilot.unity";
        private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;

        [UnityTest]
        public IEnumerator CentersArtworkAndControlsAcrossViewportAndSafeAreaChanges()
        {
            EditorSceneManager.LoadSceneInPlayMode(PilotScene, new LoadSceneParameters(LoadSceneMode.Single));
            yield return null;
            var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            var controller = document.GetComponent(Type.GetType("MainMenuToolkitPilot, Assembly-CSharp"));
            Assert.That(((Behaviour)controller).enabled, Is.True);
            var panel = document.panelSettings;
            var originalTarget = panel.targetTexture;
            RenderTexture target = null;
            var sizes = new[] { new Vector2Int(360, 800), new(390, 844), new(844, 390),
                new(768, 1024), new(1024, 768), new(1280, 720), new(1920, 1080), new(2560, 1080),
                new(390, 844), new(844, 390), new(390, 844) };

            try
            {
                for (int index = 0; index < sizes.Length; index++)
                {
                    Vector2Int size = sizes[index];
                    if (target != null) UnityEngine.Object.Destroy(target);
                    target = new RenderTexture(size.x, size.y, 24);
                    target.Create();
                    panel.targetTexture = target;
                    yield return null;
                    yield return null;
                    Rect viewport = new(0, 0, size.x, size.y);
                    // Synthetic insets, not claims about specific hardware. Coordinates are top-left.
                    Rect safe = size.x == 390 ? new Rect(0, 47, 390, 763)
                        : size.x == 844 && index != 9 ? new Rect(47, 0, 797, 369)
                        : size.x == 768 ? new Rect(0, 20, 768, 984) : viewport;
                    controller.GetType().GetMethod("UpdateLayout").Invoke(controller, new object[] { viewport, safe });
                    yield return null;
                    yield return null;

                    var root = document.rootVisualElement;
                    var art = root.Q("pilot-artwork");
                    var play = root.Q<Button>("pilot-play-button");
                    var audio = root.Q<Button>("pilot-audio-button");
                    var icon = root.Q<Image>("pilot-audio-icon");
                    AssertCenter(art.worldBound.center, safe.center, "artwork", size);
                    // Pixel-aligned layout can round either artwork edge by one pixel.
                    Assert.That(art.worldBound.height, Is.EqualTo(art.worldBound.width * 941f / 1672f).Within(1f));
                    float scale = art.worldBound.width / 1672f;
                    AssertCenter(play.worldBound.center, art.worldBound.position + new Vector2(835, 797.5f) * scale, "PLAY", size);
                    AssertCenter(audio.worldBound.center, art.worldBound.position + new Vector2(1543, 113) * scale, "audio", size);
                    AssertCenter(icon.worldBound.center, audio.worldBound.center, "audio icon", size);
                    audio.Focus();
                    yield return null;
                    AssertCenter(icon.worldBound.center, audio.worldBound.center, "focused audio icon", size);
                    play.Focus();
                    yield return null;
                    Assert.That(play.resolvedStyle.unityTextAlign, Is.EqualTo(TextAnchor.MiddleCenter));
                    foreach (var button in new[] { play, audio })
                    {
                        Assert.That(button.worldBound.width, Is.GreaterThanOrEqualTo(47.5f));
                        Assert.That(button.worldBound.height, Is.GreaterThanOrEqualTo(47.5f));
                        Assert.That(button.worldBound.xMin, Is.GreaterThanOrEqualTo(safe.xMin - 1));
                        Assert.That(button.worldBound.yMin, Is.GreaterThanOrEqualTo(safe.yMin - 1));
                        Assert.That(button.worldBound.xMax, Is.LessThanOrEqualTo(safe.xMax + 1));
                        Assert.That(button.worldBound.yMax, Is.LessThanOrEqualTo(safe.yMax + 1));
                    }
                    if (index < 8) Capture(target, $"menu-{size.x}x{size.y}.png");
                }
            }
            finally
            {
                panel.targetTexture = originalTarget;
                if (target != null) UnityEngine.Object.Destroy(target);
            }
        }

        [UnityTest]
        public IEnumerator KeyboardFocusMuteAndPlayUseExistingGameServices()
        {
            EditorSceneManager.LoadSceneInPlayMode(PilotScene, new LoadSceneParameters(LoadSceneMode.Single));
            yield return null;
            yield return null;
            var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            var play = document.rootVisualElement.Q<Button>("pilot-play-button");
            var audio = document.rootVisualElement.Q<Button>("pilot-audio-button");
            var icon = document.rootVisualElement.Q<Image>("pilot-audio-icon");
            Type settings = Type.GetType("GameAudioSettings, Assembly-CSharp");
            var enabled = settings.GetProperty("IsEnabled");
            bool original = (bool)enabled.GetValue(null);
            try
            {
                play.Focus();
                Assert.That(document.rootVisualElement.panel.focusController.focusedElement, Is.SameAs(play));
                for (int state = 0; state < 2; state++)
                {
                    audio.Focus();
                    using (var submit = NavigationSubmitEvent.GetPooled()) audio.SendEvent(submit);
                    Assert.That((bool)enabled.GetValue(null), Is.EqualTo(state == 0 ? !original : original));
                    var controller = document.GetComponent(Type.GetType("MainMenuToolkitPilot, Assembly-CSharp"));
                    string field = (bool)enabled.GetValue(null) ? "enabledIcon" : "mutedIcon";
                    Assert.That(icon.image, Is.SameAs(controller.GetType().GetField(field, PrivateInstance).GetValue(controller)));
                    Assert.That(audio.Query<Image>().ToList().Count, Is.EqualTo(1));
                }
                play.Focus();
                using (var submit = NavigationSubmitEvent.GetPooled()) play.SendEvent(submit);
                Assert.That(play.enabledSelf, Is.False);
                yield return null;
                Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("Level1_BeeBoss"));
                var service = Type.GetType("RunSessionService, Assembly-CSharp").GetProperty("Instance").GetValue(null);
                var session = service.GetType().GetProperty("Session").GetValue(service);
                Assert.That(session.GetType().GetProperty("RunId").GetValue(session), Is.Not.EqualTo(Guid.Empty));
            }
            finally
            {
                settings.GetMethod("SetEnabled").Invoke(null, new object[] { original });
                SceneManager.LoadScene("MainMenu");
            }
        }

        private static void AssertCenter(Vector2 actual, Vector2 expected, string element, Vector2Int size)
        {
            Assert.That(Vector2.Distance(actual, expected), Is.LessThanOrEqualTo(1f), $"{element} at {size}");
        }

        private static void Capture(RenderTexture target, string filename)
        {
            var previous = RenderTexture.active;
            var image = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
            try
            {
                RenderTexture.active = target;
                image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                image.Apply();
                string directory = Path.Combine(Path.GetTempPath(), "three-bosses-menu-pilot");
                Directory.CreateDirectory(directory);
                File.WriteAllBytes(Path.Combine(directory, filename), image.EncodeToPNG());
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.Destroy(image);
            }
        }
    }
}
#endif
