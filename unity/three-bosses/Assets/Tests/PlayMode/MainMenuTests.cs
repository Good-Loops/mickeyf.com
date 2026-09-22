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
    public sealed class MainMenuTests
    {
        private const string MenuScene = "Assets/Scenes/UI/MainMenu.unity";
        private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;

        [UnityTest]
        public IEnumerator BuildEntryAndTouchOwnershipUseTheReplacementMenu()
        {
            var entry = UnityEditor.EditorBuildSettings.scenes[0];
            Assert.That(entry.path, Is.EqualTo(MenuScene));
            Assert.That(entry.enabled, Is.True);
            Assert.That(entry.guid.ToString(), Is.EqualTo(UnityEditor.AssetDatabase.AssetPathToGUID(MenuScene)));
            Assert.That(UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEditor.SceneAsset>(
                "Assets/Scenes/UI/MainMenuToolkitPilot.unity"), Is.Null);
            SceneManager.LoadScene("MainMenu");
            yield return null;
            yield return null;
            var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            Assert.That(UnityEngine.EventSystems.EventSystem.current.currentInputModule, Is.Not.Null);
            var host = new GameObject("Menu touch ownership test");
            var scroll = host.AddComponent(Type.GetType("WebPageTouchScroll, Assembly-CSharp"));
            var ownsTouch = scroll.GetType().GetMethod("IsInteractiveTouchOrigin", PrivateInstance);
            try
            {
                foreach (string name in new[] { "pilot-play-button", "pilot-audio-button", "pilot-artwork" })
                {
                    Vector2 center = document.rootVisualElement.Q(name).worldBound.center;
                    var position = new Vector2(center.x, Screen.height - center.y);
                    Assert.That((bool)ownsTouch.Invoke(scroll, new object[] { position }),
                        Is.EqualTo(name != "pilot-artwork"), $"Touch ownership for {name}");
                }
            }
            finally
            {
                UnityEngine.Object.Destroy(host);
            }
        }

        [UnityTest]
        public IEnumerator CentersArtworkAndControlsAcrossViewportAndSafeAreaChanges()
        {
            EditorSceneManager.LoadSceneInPlayMode(MenuScene, new LoadSceneParameters(LoadSceneMode.Single));
            yield return null;
            var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            var controller = document.GetComponent(Type.GetType("MainMenuController, Assembly-CSharp"));
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
                    Vector2 playFrameCenter = art.worldBound.position + new Vector2(831.5f, 804f) * scale;
                    AssertCenter(play.worldBound.center, playFrameCenter, "PLAY", size);
                    AssertCenter(audio.worldBound.center, art.worldBound.position + new Vector2(1543, 113) * scale, "audio", size);
                    AssertCenter(icon.worldBound.center, audio.worldBound.center, "audio icon", size);
                    Assert.That(icon.worldBound.height, Is.EqualTo(Mathf.Max(20f, 37f * scale)).Within(1f));
                    audio.Focus();
                    yield return null;
                    AssertCenter(icon.worldBound.center, audio.worldBound.center, "focused audio icon", size);
                    play.Focus();
                    yield return null;
                    Assert.That(play.resolvedStyle.unityTextAlign, Is.EqualTo(TextAnchor.MiddleCenter));
                    foreach (var button in new[] { play, audio })
                    {
                        Assert.That(button.resolvedStyle.borderTopWidth, Is.Zero, "Do not overlay a box on the artwork.");
                        Assert.That(button.worldBound.width, Is.GreaterThanOrEqualTo(47.5f));
                        Assert.That(button.worldBound.height, Is.GreaterThanOrEqualTo(47.5f));
                        Assert.That(button.worldBound.xMin, Is.GreaterThanOrEqualTo(safe.xMin - 1));
                        Assert.That(button.worldBound.yMin, Is.GreaterThanOrEqualTo(safe.yMin - 1));
                        Assert.That(button.worldBound.xMax, Is.LessThanOrEqualTo(safe.xMax + 1));
                        Assert.That(button.worldBound.yMax, Is.LessThanOrEqualTo(safe.yMax + 1));
                    }
                    if (index < 8) Capture(target, $"menu-{size.x}x{size.y}.png", playFrameCenter, play.resolvedStyle.fontSize);
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
            EditorSceneManager.LoadSceneInPlayMode(MenuScene, new LoadSceneParameters(LoadSceneMode.Single));
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
                    var controller = document.GetComponent(Type.GetType("MainMenuController, Assembly-CSharp"));
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

        private static void Capture(RenderTexture target, string filename, Vector2 captionCenter, float fontSize)
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
                AssertCaptionInkCentered(image, captionCenter, fontSize);
            }
            finally
            {
                RenderTexture.active = previous;
                UnityEngine.Object.Destroy(image);
            }
        }

        private static void AssertCaptionInkCentered(Texture2D image, Vector2 expected, float fontSize)
        {
            int left = image.width, right = -1, top = image.height, bottom = -1;
            // Search the dark caption interior, excluding the red frame and its glow.
            for (int y = Mathf.FloorToInt(expected.y - fontSize / 2); y <= expected.y + fontSize / 2; y++)
            for (int x = Mathf.FloorToInt(expected.x - fontSize * 2); x <= expected.x + fontSize * 2; x++)
            {
                Color pixel = image.GetPixel(x, image.height - 1 - y);
                if (pixel.r < 0.75f || pixel.g < 0.65f || pixel.b < 0.65f) continue;
                left = Mathf.Min(left, x);
                right = Mathf.Max(right, x);
                top = Mathf.Min(top, y);
                bottom = Mathf.Max(bottom, y);
            }
            Assert.That(right, Is.GreaterThanOrEqualTo(left), "PLAY glyphs must be visible.");
            Vector2 inkCenter = new((left + right + 1) / 2f, (top + bottom + 1) / 2f);
            Assert.That(Vector2.Distance(inkCenter, expected), Is.LessThanOrEqualTo(1.5f),
                $"Visible PLAY ink at {image.width}x{image.height}: {inkCenter}, frame: {expected}");
        }
    }
}
#endif
