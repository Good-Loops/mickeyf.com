using System;
using System.Collections;
using System.Globalization;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class RunTimerDisplayTests
    {
        private static readonly string[] BattleScenes =
        {
            "Level1_BeeBoss",
            "Level2_CyborgBoss",
            "Level3_Kraken"
        };

        [UnityTest]
        public IEnumerator BattleScenesUseStableFramingAndOneTopCenterTimerBeforeOverlays()
        {
            Type displayType = RequireRuntimeType("RunTimerDisplay");
            Type pixelPerfectCameraType = RequireType(
                "UnityEngine.Rendering.Universal.PixelPerfectCamera, Unity.RenderPipelines.Universal.2D.Runtime");

            foreach (string sceneName in BattleScenes)
            {
                SceneManager.LoadScene(sceneName);
                yield return null;

                Camera camera = Camera.main;
                Assert.That(camera, Is.Not.Null, sceneName);
                Assert.That(camera.orthographic, Is.True, sceneName);

                Component pixelPerfectCamera = camera.GetComponent(pixelPerfectCameraType);
                Assert.That(pixelPerfectCamera, Is.Not.Null, sceneName);
                Assert.That(((Behaviour)pixelPerfectCamera).enabled, Is.True, sceneName);
                Assert.That(GetProperty<int>(pixelPerfectCamera, "assetsPPU"), Is.EqualTo(32), sceneName);
                Assert.That(GetProperty<int>(pixelPerfectCamera, "refResolutionX"), Is.EqualTo(1280), sceneName);
                Assert.That(GetProperty<int>(pixelPerfectCamera, "refResolutionY"), Is.EqualTo(720), sceneName);
                Assert.That(
                    GetProperty<object>(pixelPerfectCamera, "cropFrame").ToString(),
                    Is.EqualTo("StretchFill"),
                    sceneName);
                Assert.That(camera.aspect, Is.EqualTo(16f / 9f).Within(0.001f), sceneName);
                Assert.That(camera.orthographicSize, Is.EqualTo(11.25f).Within(0.001f), sceneName);

                MonoBehaviour[] displays = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                        FindObjectsInactive.Include,
                        FindObjectsSortMode.None)
                    .Where(behaviour => behaviour.GetType() == displayType)
                    .ToArray();

                Assert.That(displays, Has.Length.EqualTo(1), sceneName);
                MonoBehaviour display = displays[0];
                Assert.That(display.gameObject.name, Is.EqualTo("Phase12_RunTimer"), sceneName);
                Assert.That(display.transform.parent.name, Is.EqualTo("UI"), sceneName);

                Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
                Component label = display.GetComponent(textType);
                Assert.That(label, Is.Not.Null, sceneName);
                Assert.That(GetProperty<bool>(label, "raycastTarget"), Is.False, sceneName);
                Assert.That(
                    GetProperty<string>(label, "text"),
                    Does.Match(@"^\d{2,}:\d{2}\.\d{3}$"),
                    sceneName);

                RectTransform rectTransform = display.GetComponent<RectTransform>();
                Assert.That(rectTransform.anchorMin, Is.EqualTo(new Vector2(0.5f, 1f)), sceneName);
                Assert.That(rectTransform.anchorMax, Is.EqualTo(new Vector2(0.5f, 1f)), sceneName);
                Assert.That(rectTransform.pivot, Is.EqualTo(new Vector2(0.5f, 1f)), sceneName);
                Assert.That(rectTransform.anchoredPosition, Is.EqualTo(new Vector2(0f, -2f)), sceneName);
                Assert.That(rectTransform.sizeDelta, Is.EqualTo(new Vector2(210f, 24f)), sceneName);
                Assert.That(GetProperty<float>(label, "fontSize"), Is.EqualTo(22f), sceneName);
                Assert.That(GetProperty<float>(label, "characterSpacing"), Is.EqualTo(2f), sceneName);
                Assert.That(GetProperty<object>(label, "fontStyle").ToString(), Is.EqualTo("Normal"), sceneName);

                UnityEngine.Object font = GetProperty<UnityEngine.Object>(label, "font");
                Assert.That(font, Is.Not.Null, sceneName);
                Assert.That(font.name, Is.EqualTo("Oxanium-Bold Timer SDF"), sceneName);
                Material fontMaterial = GetProperty<Material>(label, "fontSharedMaterial");
                Assert.That(fontMaterial, Is.Not.Null, sceneName);
                Assert.That(
                    fontMaterial.mainTexture,
                    Is.SameAs(GetProperty<Texture>(font, "atlasTexture")),
                    sceneName);
                MethodInfo hasCharacters = font.GetType().GetMethod(
                    "HasCharacters",
                    BindingFlags.Instance | BindingFlags.Public,
                    null,
                    new[] { typeof(string) },
                    null);
                Assert.That(hasCharacters, Is.Not.Null, sceneName);
                Assert.That((bool)hasCharacters.Invoke(font, new object[] { "00:00.000" }), Is.True, sceneName);

                Transform sceneFade = display.transform.parent.Find("SceneFade");
                Assert.That(sceneFade, Is.Not.Null, sceneName);
                Assert.That(
                    display.transform.GetSiblingIndex(),
                    Is.LessThan(sceneFade.GetSiblingIndex()),
                    sceneName);

                Transform countdown = display.transform.parent.Find("Phase12_CountdownOverlay");
                if (countdown != null)
                {
                    Assert.That(
                        display.transform.GetSiblingIndex(),
                        Is.LessThan(countdown.GetSiblingIndex()),
                        sceneName);
                }
            }
        }

        [UnityTest]
        public IEnumerator TimerReadsPersistentClockAndFreezesAfterDeath()
        {
            Type serviceType = RequireRuntimeType("RunSessionService");
            Type displayType = RequireRuntimeType("RunTimerDisplay");
            object service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null);
            Assert.That(service, Is.Not.Null);

            object session = serviceType.GetProperty(
                    "Session",
                    BindingFlags.Public | BindingFlags.Instance)
                ?.GetValue(service);
            Assert.That(session, Is.Not.Null);

            Type bossIdType = session.GetType().Assembly.GetType("ThreeBosses.Run.BossId");
            Assert.That(bossIdType, Is.Not.Null);
            object bee = Enum.Parse(bossIdType, "Bee");
            RequireMethod(session.GetType(), "BeginPractice").Invoke(session, new[] { bee });

            GameObject timerObject = new("Timer Test", typeof(RectTransform));
            timerObject.AddComponent(displayType);
            Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            Component label = timerObject.GetComponent(textType);

            yield return new WaitForSecondsRealtime(0.06f);

            string runningValue = GetProperty<string>(label, "text");
            Assert.That(runningValue, Does.Match(@"^\d{2,}:\d{2}\.\d{3}$"));
            Assert.That(runningValue, Is.Not.EqualTo("00:00.000"));

            bool deathAccepted = (bool)RequireMethod(session.GetType(), "RecordDeath").Invoke(session, null);
            Assert.That(deathAccepted, Is.True);
            yield return null;
            string frozenValue = GetProperty<string>(label, "text");

            yield return new WaitForSecondsRealtime(0.06f);

            Assert.That(GetProperty<string>(label, "text"), Is.EqualTo(frozenValue));
            UnityEngine.Object.Destroy(timerObject);
        }

        [TestCase(0d, "00:00.000")]
        [TestCase(65.432d, "01:05.432")]
        [TestCase(59.9996d, "01:00.000")]
        [TestCase(-1d, "00:00.000")]
        [TestCase(double.NaN, "00:00.000")]
        [TestCase(double.PositiveInfinity, "00:00.000")]
        public void FormatterProducesCanonicalTime(double elapsedSeconds, string expected)
        {
            Assert.That(FormatTime(elapsedSeconds), Is.EqualTo(expected));
        }

        [Test]
        public void FormatterAlwaysUsesInvariantDecimalPoint()
        {
            CultureInfo originalCulture = CultureInfo.CurrentCulture;

            try
            {
                CultureInfo.CurrentCulture = new CultureInfo("pt-BR");
                Assert.That(FormatTime(65.432d), Is.EqualTo("01:05.432"));
            }
            finally
            {
                CultureInfo.CurrentCulture = originalCulture;
            }
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene("MainMenu");
            yield return null;

            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            if (serviceType == null)
                yield break;

            MonoBehaviour service = UnityEngine.Object.FindFirstObjectByType(serviceType) as MonoBehaviour;
            if (service != null)
                UnityEngine.Object.Destroy(service.gameObject);
        }

        private static string FormatTime(double elapsedSeconds)
        {
            Type formatterType = RequireRuntimeType("RunUiFormatter");
            MethodInfo formatMethod = RequireMethod(formatterType, "FormatTime");
            return (string)formatMethod.Invoke(null, new object[] { elapsedSeconds });
        }

        private static Type RequireRuntimeType(string name)
        {
            return RequireType($"{name}, Assembly-CSharp");
        }

        private static Type RequireType(string qualifiedName)
        {
            Type type = Type.GetType(qualifiedName);
            Assert.That(type, Is.Not.Null, $"Type {qualifiedName} was not found.");
            return type;
        }

        private static MethodInfo RequireMethod(Type type, string name)
        {
            MethodInfo method = type.GetMethod(
                name,
                BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public);
            Assert.That(method, Is.Not.Null, $"Method {type.FullName}.{name} was not found.");
            return method;
        }

        private static T GetProperty<T>(object target, string name)
        {
            PropertyInfo property = target.GetType().GetProperty(
                name,
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(property, Is.Not.Null, $"Property {target.GetType().FullName}.{name} was not found.");
            return (T)property.GetValue(target);
        }
    }
}
