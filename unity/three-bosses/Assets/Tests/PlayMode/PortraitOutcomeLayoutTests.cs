using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class PortraitOutcomeLayoutTests
    {
        private static readonly OutcomeSceneContract[] SceneContracts =
        {
            new(
                "Transition_BeeToCyborg",
                "Bee",
                true,
                new TextLayoutContract(
                    "Boss Split Caption",
                    new Vector2(74f, -58f),
                    new Vector2(300f, 30f),
                    new Vector2(-150f, -315f),
                    new Vector2(300f, 36f),
                    "Left"),
                new TextLayoutContract(
                    "Boss Split Value",
                    new Vector2(74f, -88f),
                    new Vector2(300f, 44f),
                    new Vector2(150f, -315f),
                    new Vector2(300f, 36f),
                    "Left")),
            new(
                "Transition_CyborgToKraken",
                "Cyborg",
                true,
                new TextLayoutContract(
                    "Boss Split Caption",
                    new Vector2(74f, -58f),
                    new Vector2(300f, 30f),
                    new Vector2(-150f, -298f),
                    new Vector2(300f, 36f),
                    "Left"),
                new TextLayoutContract(
                    "Boss Split Value",
                    new Vector2(74f, -88f),
                    new Vector2(300f, 44f),
                    new Vector2(150f, -298f),
                    new Vector2(300f, 36f),
                    "Left")),
            new(
                "Defeat_Bee",
                "Bee",
                false,
                new TextLayoutContract(
                    "Time Survived Value",
                    new Vector2(535f, -580f),
                    new Vector2(605f, 72f),
                    new Vector2(0f, -580f),
                    new Vector2(605f, 72f),
                    "Center")),
            new(
                "Defeat_Cyborg",
                "Cyborg",
                false,
                new TextLayoutContract(
                    "Time Survived Value",
                    new Vector2(580f, -592f),
                    new Vector2(570f, 74f),
                    new Vector2(0f, -592f),
                    new Vector2(570f, 74f),
                    "Center")),
            new(
                "Defeat_Kraken",
                "Kraken",
                false,
                new TextLayoutContract(
                    "Time Survived Value",
                    new Vector2(580f, -592f),
                    new Vector2(570f, 74f),
                    new Vector2(0f, -592f),
                    new Vector2(570f, 74f),
                    "Center")),
        };

        [UnityTest]
        public IEnumerator OutcomeScenesCenterConfiguredTextOnlyForPortraitUi()
        {
            Type serviceType = RequireRuntimeType("RunSessionService");
            Component service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null) as Component;
            Assert.That(service, Is.Not.Null);

            MethodInfo configurePortraitLayout = serviceType.GetMethod(
                "ConfigurePortraitUiLayout",
                BindingFlags.Public | BindingFlags.Instance);
            Assert.That(configurePortraitLayout, Is.Not.Null);
            configurePortraitLayout.Invoke(service, new object[] { "0" });
            object session = serviceType.GetProperty(
                    "Session",
                    BindingFlags.Public | BindingFlags.Instance)
                ?.GetValue(service);
            Assert.That(session, Is.Not.Null);

            foreach (OutcomeSceneContract contract in SceneContracts)
            {
                PrepareOutcomeSession(session, contract.BossName, contract.IsTransition);
                SceneManager.LoadScene(contract.SceneName);
                yield return null;

                Type layoutType = RequireRuntimeType("PortraitTextGroupLayout");
                Component[] layouts = SceneManager.GetActiveScene()
                    .GetRootGameObjects()
                    .SelectMany(root => root.GetComponentsInChildren(layoutType, true))
                    .ToArray();
                Assert.That(layouts, Has.Length.EqualTo(1), contract.SceneName);

                FieldInfo targetsField = layoutType.GetField(
                    "textTargets",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                Assert.That(targetsField, Is.Not.Null, contract.SceneName);
                Array targetArray = targetsField.GetValue(layouts[0]) as Array;
                Assert.That(targetArray, Is.Not.Null, contract.SceneName);
                Component[] targets = targetArray.Cast<Component>().ToArray();
                Assert.That(
                    targets.Select(target => target.name),
                    Is.EqualTo(contract.TextTargets.Select(target => target.Name)),
                    contract.SceneName);

                for (int index = 0; index < targets.Length; index++)
                {
                    Component target = targets[index];
                    TextLayoutContract expected = contract.TextTargets[index];
                    RectTransform rectTransform = target.GetComponent<RectTransform>();
                    Assert.That(rectTransform.anchorMin, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchorMax, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.pivot, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchoredPosition, Is.EqualTo(expected.DesktopPosition), contract.SceneName);
                    Assert.That(rectTransform.sizeDelta, Is.EqualTo(expected.DesktopSize), contract.SceneName);
                    Assert.That(
                        target.GetType().GetProperty("alignment")?.GetValue(target)?.ToString(),
                        Is.EqualTo(expected.DesktopAlignment),
                        contract.SceneName);
                }

                configurePortraitLayout.Invoke(service, new object[] { "1" });
                for (int index = 0; index < targets.Length; index++)
                {
                    Component target = targets[index];
                    TextLayoutContract expected = contract.TextTargets[index];
                    RectTransform rectTransform = target.GetComponent<RectTransform>();
                    Assert.That(rectTransform.anchorMin, Is.EqualTo(new Vector2(0.5f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchorMax, Is.EqualTo(new Vector2(0.5f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.pivot, Is.EqualTo(new Vector2(0.5f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchoredPosition, Is.EqualTo(expected.PortraitPosition), contract.SceneName);
                    Assert.That(rectTransform.sizeDelta, Is.EqualTo(expected.PortraitSize), contract.SceneName);
                    Assert.That(
                        target.GetType().GetProperty("alignment")?.GetValue(target)?.ToString(),
                        Is.EqualTo("Center"),
                        contract.SceneName);
                }

                configurePortraitLayout.Invoke(service, new object[] { "0" });
                for (int index = 0; index < targets.Length; index++)
                {
                    Component target = targets[index];
                    TextLayoutContract expected = contract.TextTargets[index];
                    RectTransform rectTransform = target.GetComponent<RectTransform>();
                    Assert.That(rectTransform.anchorMin, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchorMax, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.pivot, Is.EqualTo(new Vector2(0f, 1f)), contract.SceneName);
                    Assert.That(rectTransform.anchoredPosition, Is.EqualTo(expected.DesktopPosition), contract.SceneName);
                    Assert.That(rectTransform.sizeDelta, Is.EqualTo(expected.DesktopSize), contract.SceneName);
                    Assert.That(
                        target.GetType().GetProperty("alignment")?.GetValue(target)?.ToString(),
                        Is.EqualTo(expected.DesktopAlignment),
                        contract.SceneName);
                }
            }
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene("MainMenu");
            yield return null;

            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            MonoBehaviour service = serviceType == null
                ? null
                : UnityEngine.Object.FindFirstObjectByType(serviceType) as MonoBehaviour;
            if (service != null)
                UnityEngine.Object.Destroy(service.gameObject);
        }

        private static Type RequireRuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Type {name} was not found.");
            return type;
        }

        private static void PrepareOutcomeSession(object session, string bossName, bool isTransition)
        {
            Type sessionType = session.GetType();
            Type bossIdType = sessionType.Assembly.GetType("ThreeBosses.Run.BossId");
            Assert.That(bossIdType, Is.Not.Null);
            object boss = Enum.Parse(bossIdType, bossName);

            if (isTransition && bossName == "Bee")
            {
                sessionType.GetMethod("BeginNewRun")?.Invoke(session, null);
                Assert.That(sessionType.GetMethod("StartRun")?.Invoke(session, null), Is.True);
            }
            else
            {
                sessionType.GetMethod("BeginPractice")?.Invoke(session, new[] { boss });
            }

            string outcomeMethod = isTransition ? "RecordBossDefeat" : "RecordDeath";
            object outcome = sessionType.GetMethod(outcomeMethod)?.Invoke(
                session,
                isTransition ? new[] { boss } : null);
            Assert.That(outcome, Is.Not.Null, $"{outcomeMethod} did not return a result.");
        }

        private sealed class OutcomeSceneContract
        {
            public OutcomeSceneContract(
                string sceneName,
                string bossName,
                bool isTransition,
                params TextLayoutContract[] textTargets)
            {
                SceneName = sceneName;
                BossName = bossName;
                IsTransition = isTransition;
                TextTargets = textTargets;
            }

            public string SceneName { get; }
            public string BossName { get; }
            public bool IsTransition { get; }
            public TextLayoutContract[] TextTargets { get; }
        }

        private readonly struct TextLayoutContract
        {
            public TextLayoutContract(
                string name,
                Vector2 desktopPosition,
                Vector2 desktopSize,
                Vector2 portraitPosition,
                Vector2 portraitSize,
                string desktopAlignment)
            {
                Name = name;
                DesktopPosition = desktopPosition;
                DesktopSize = desktopSize;
                PortraitPosition = portraitPosition;
                PortraitSize = portraitSize;
                DesktopAlignment = desktopAlignment;
            }

            public string Name { get; }
            public Vector2 DesktopPosition { get; }
            public Vector2 DesktopSize { get; }
            public Vector2 PortraitPosition { get; }
            public Vector2 PortraitSize { get; }
            public string DesktopAlignment { get; }
        }
    }
}
