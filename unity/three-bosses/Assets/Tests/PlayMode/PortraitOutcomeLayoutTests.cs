#if UNITY_EDITOR
using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace ThreeBosses.Tests
{
    [Category("ScreenUI")]
    public sealed class PortraitOutcomeLayoutTests
    {
        private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
        private static readonly string[] Scenes = { "Defeat_Bee", "Defeat_Cyborg", "Defeat_Kraken",
            "Transition_BeeToCyborg", "Transition_CyborgToKraken", "End" };

        [UnityTest]
        public IEnumerator OutcomeArtworkReadoutsAndActionsFitLandscapePortraitAndSafeAreas()
        {
            foreach (string sceneName in Scenes)
            {
                yield return PrepareSession(sceneName);
                SceneManager.LoadScene(sceneName);
                yield return null;
                yield return null;
                var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
                Assert.That(document, Is.Not.Null, sceneName);
                var view = document.GetComponent(RuntimeType("OutcomeScreenView"));
                Assert.That((bool)view.GetType().GetProperty("IsReady").GetValue(view), Is.True);
                var transition = UnityEngine.Object.FindFirstObjectByType(RuntimeType("BossTransitionScreenController")) as MonoBehaviour;
                transition?.StopAllCoroutines();
                Invoke(view, "FadeOut", 0f);
                var originalPanel = document.panelSettings;
                var panel = UnityEngine.Object.Instantiate(originalPanel);
                document.panelSettings = panel;
                RenderTexture target = null;
                bool originalPortrait = (bool)Service.GetType().GetProperty("UsePortraitUiLayout").GetValue(Service);
                var sizes = new[] { new Vector2Int(1280, 720), new Vector2Int(390, 844),
                    new Vector2Int(844, 390), new Vector2Int(1280, 720) };
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
                        Invoke(Service, "ConfigurePortraitUiLayout", index == 1 ? "1" : "0");
                        Rect viewport = new(0f, 0f, size.x, size.y);
                        Rect safe = index == 1 ? new Rect(0f, 47f, 390f, 763f)
                            : index == 2 ? new Rect(47f, 0f, 750f, 369f) : viewport;
                        Invoke(view, "UpdateLayout", viewport, safe);
                        yield return null;
                        yield return null;
                        var root = document.rootVisualElement;
                        var art = root.Q("outcome-artwork");
                        AssertCenter(art.worldBound.center, safe.center, sceneName + " artwork");
                        Assert.That(art.worldBound.height, Is.EqualTo(art.worldBound.width * 941f / 1672f).Within(1f));
                        float scale = art.worldBound.width / 1672f;
                        Vector2 timeCenter = sceneName switch
                        {
                            "Defeat_Bee" => new Vector2(837.5f, 616f),
                            "Defeat_Cyborg" => new Vector2(856f, 629f),
                            "Defeat_Kraken" => new Vector2(855f, 629f),
                            "End" => new Vector2(535f, 729f),
                            "Transition_BeeToCyborg" when index == 1 => new Vector2(986f, 333f),
                            "Transition_CyborgToKraken" when index == 1 => new Vector2(986f, 316f),
                            _ => new Vector2(224f, 110f)
                        };
                        AssertCenter(root.Q("time-value").worldBound.center, art.worldBound.position + timeCenter * scale,
                            sceneName + " painted time readout");
                        if (sceneName == "End")
                        {
                            AssertCenter(root.Q("score-value").worldBound.center,
                                art.worldBound.position + new Vector2(833f, 729f) * scale, "painted score");
                            AssertCenter(root.Q("rank-value").worldBound.center,
                                art.worldBound.position + new Vector2(1153f, 729f) * scale, "painted rank");
                        }
                        foreach (Button button in root.Query<Button>().ToList().Where(button => button.resolvedStyle.display != DisplayStyle.None))
                        {
                            Assert.That(button.worldBound.width, Is.GreaterThanOrEqualTo(47.5f), button.name);
                            Assert.That(button.worldBound.height, Is.GreaterThanOrEqualTo(47.5f), button.name);
                            Assert.That(button.worldBound.xMin, Is.GreaterThanOrEqualTo(safe.xMin - 1f), button.name);
                            Assert.That(button.worldBound.yMin, Is.GreaterThanOrEqualTo(safe.yMin - 1f), button.name);
                            Assert.That(button.worldBound.xMax, Is.LessThanOrEqualTo(safe.xMax + 1f), button.name);
                            Assert.That(button.worldBound.yMax, Is.LessThanOrEqualTo(safe.yMax + 1f), button.name);
                            Assert.That(button.resolvedStyle.borderTopWidth, Is.Zero, "Do not redraw painted frames.");
                            Assert.That(button.resolvedStyle.unityTextAlign, Is.EqualTo(TextAnchor.MiddleCenter));
                            AssertTextFits(button);
                            AssertButtonCaptionFitsPaintedFrame(button, sceneName, scale);
                        }
                        foreach (Label label in root.Query<Label>().ToList().Where(label => label.resolvedStyle.display != DisplayStyle.None))
                        {
                            Assert.That(label.resolvedStyle.unityTextAlign, Is.EqualTo(TextAnchor.MiddleCenter));
                            AssertTextFits(label);
                        }
                        if (sceneName == "End" && index == 1)
                        {
                            foreach (string status in new[] { "SUBMIT SCORE", "SUBMITTING...", "SUBMITTED", "SIGN IN REQUIRED",
                                "RETRY SUBMISSION", "START A NEW RUN", "SUBMISSION FAILED", "SUBMISSION LOCKED" })
                            {
                                Invoke(view, "SetSubmission", status, true);
                                yield return null;
                                AssertTextFits(root.Q<Button>("submit-score-button"));
                                AssertButtonCaptionFitsPaintedFrame(root.Q<Button>("submit-score-button"), sceneName, scale);
                                if (status == "SUBMISSION FAILED") Capture(target, "End-390x844-submission-failed.png");
                            }
                            Invoke(view, "SetSubmission", "SUBMISSION LOCKED", false);
                            yield return null;
                        }
                        if (index < 2) Capture(target, $"{sceneName}-{size.x}x{size.y}.png");
                    }
                }
                finally
                {
                    Invoke(Service, "ConfigurePortraitUiLayout", originalPortrait ? "1" : "0");
                    document.panelSettings = originalPanel;
                    if (target != null) UnityEngine.Object.Destroy(target);
                    UnityEngine.Object.Destroy(panel);
                }
            }
        }

        [UnityTest]
        public IEnumerator CompletionReflectsEverySubmissionStateAndMissingTicketStartsANewRun()
        {
            yield return LoadCompletion();
            var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            Button submit = document.rootVisualElement.Q<Button>("submit-score-button");
            AssertSubmission(submit, "SUBMISSION LOCKED", false);
            object coordinator = Service.GetType().GetField("submissionCoordinator", PrivateInstance).GetValue(Service);
            Invoke(Service, "ConfigureRunSubmission", "1");
            AssertSubmission(submit, "SUBMIT SCORE", true);
            BeginSubmission(coordinator);
            AssertSubmission(submit, "SUBMITTING...", false);
            FailSubmission(coordinator, "UNAUTHORIZED");
            AssertSubmission(submit, "SIGN IN REQUIRED", true);
            BeginSubmission(coordinator);
            FailSubmission(coordinator, "NETWORK_ERROR");
            AssertSubmission(submit, "RETRY SUBMISSION", true);
            BeginSubmission(coordinator);
            object session = Session;
            double seconds = (double)session.GetType().GetProperty("ElapsedSeconds").GetValue(session);
            Type calculator = session.GetType().Assembly.GetType("ThreeBosses.Run.RunScoreCalculator");
            int milliseconds = (int)calculator.GetMethod("CanonicalizeCompletionTimeMilliseconds").Invoke(null, new object[] { seconds });
            Assert.That((bool)Invoke(coordinator, "CompleteSuccess", RunId, milliseconds,
                session.GetType().GetProperty("Score").GetValue(session), session.GetType().GetProperty("Rank").GetValue(session)), Is.True);
            AssertSubmission(submit, "SUBMITTED", false);

            yield return LoadCompletion();
            document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            submit = document.rootVisualElement.Q<Button>("submit-score-button");
            coordinator = Service.GetType().GetField("submissionCoordinator", PrivateInstance).GetValue(Service);
            Invoke(Service, "ConfigureRunSubmission", "1");
            BeginSubmission(coordinator);
            FailSubmission(coordinator, "INVALID_RUN");
            AssertSubmission(submit, "SUBMISSION FAILED", false);

            yield return LoadCompletion();
            document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            submit = document.rootVisualElement.Q<Button>("submit-score-button");
            coordinator = Service.GetType().GetField("submissionCoordinator", PrivateInstance).GetValue(Service);
            Invoke(Service, "ConfigureRunSubmission", "1");
            BeginSubmission(coordinator);
            FailSubmission(coordinator, "RUN_TICKET_UNAVAILABLE");
            AssertSubmission(submit, "START A NEW RUN", true);
            var controller = document.GetComponent(RuntimeType("EndScreenController"));
            controller.GetType().GetField("firstLevelSceneName", PrivateInstance).SetValue(controller, "MainMenu");
            controller.GetType().GetField("fadeDurationSeconds", PrivateInstance).SetValue(controller, 0f);
            string previousRun = RunId;
            submit.Focus();
            using (var click = NavigationSubmitEvent.GetPooled()) submit.SendEvent(click);
            yield return null;
            Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("MainMenu"));
            Assert.That(RunId, Is.Not.EqualTo(previousRun));
            Assert.That(Session.GetType().GetProperty("Phase").GetValue(Session).ToString(), Is.EqualTo("Countdown"));
        }

        [UnityTest]
        public IEnumerator DefeatNavigationUsesToolkitActions()
        {
            foreach (string action in new[] { "try-again-button", "back-to-menu-button" })
            {
                yield return PrepareSession("Defeat_Bee");
                SceneManager.LoadScene("Defeat_Bee");
                yield return null;
                yield return null;
                var document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
                var controller = document.GetComponent(RuntimeType("DefeatScreenController"));
                controller.GetType().GetField("firstLevelSceneName", PrivateInstance).SetValue(controller, "MainMenu");
                controller.GetType().GetField("fadeDurationSeconds", PrivateInstance).SetValue(controller, 0f);
                string previousRun = RunId;
                Button button = document.rootVisualElement.Q<Button>(action);
                button.Focus();
                using (var click = NavigationSubmitEvent.GetPooled()) button.SendEvent(click);
                yield return null;
                Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("MainMenu"));
                if (action == "try-again-button") Assert.That(RunId, Is.Not.EqualTo(previousRun));
                else Assert.That(RunId, Is.EqualTo(previousRun));
            }
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            Time.timeScale = 1f;
            Invoke(Service, "ConfigurePortraitUiLayout", "0");
            Invoke(Service, "ConfigureRunSubmission", "0");
            SceneManager.LoadScene("MainMenu");
            yield return null;
            if (Service is MonoBehaviour service) UnityEngine.Object.Destroy(service.gameObject);
            yield return null;
        }

        private static object Service => RuntimeType("RunSessionService").GetProperty("Instance").GetValue(null);
        private static object Session => Service.GetType().GetProperty("Session").GetValue(Service);
        private static string RunId => Session.GetType().GetProperty("RunId").GetValue(Session).ToString();
        private static Type RuntimeType(string name) => Type.GetType(name + ", Assembly-CSharp", true);
        private static object Invoke(object instance, string method, params object[] args) =>
            instance.GetType().GetMethod(method).Invoke(instance, args);

        private static IEnumerator PrepareSession(string sceneName)
        {
            object session = Session;
            Type bossType = session.GetType().Assembly.GetType("ThreeBosses.Run.BossId");
            object Boss(string name) => Enum.Parse(bossType, name);
            Invoke(Service, "ConfigureRunSubmission", "0");
            if (sceneName == "End")
            {
                Invoke(session, "BeginNewRun");
                Invoke(session, "StartRun");
                yield return null;
                foreach (string boss in new[] { "Bee", "Cyborg", "Kraken" })
                {
                    Invoke(session, "RecordBossDefeat", Boss(boss));
                    if (boss != "Kraken") Invoke(session, "EnterNextBoss", Boss(boss == "Bee" ? "Cyborg" : "Kraken"));
                }
                // Match the existing end-screen fixture: use a valid completed duration
                // without waiting through a full fight or bypassing score validation.
                FieldInfo elapsed = session.GetType().GetField("finalElapsedSeconds", PrivateInstance);
                Assert.That(elapsed, Is.Not.Null);
                elapsed.SetValue(session, 82d);
            }
            else
            {
                bool transition = sceneName.StartsWith("Transition_", StringComparison.Ordinal);
                string boss = sceneName.Contains("Bee") ? "Bee" : sceneName.Contains("Cyborg") ? "Cyborg" : "Kraken";
                Invoke(session, "BeginPractice", Boss(boss));
                yield return null;
                if (transition) Invoke(session, "RecordBossDefeat", Boss(boss));
                else Invoke(session, "RecordDeath");
            }
        }

        private static IEnumerator LoadCompletion()
        {
            yield return PrepareSession("End");
            SceneManager.LoadScene("End");
            yield return null;
            yield return null;
        }

        private static void BeginSubmission(object coordinator) =>
            Assert.That((bool)Invoke(coordinator, "TryBegin", new object[] { null }), Is.True);

        private static void FailSubmission(object coordinator, string error) =>
            Invoke(coordinator, "CompleteFailure", RunId, error);

        private static void AssertSubmission(Button button, string label, bool enabled)
        {
            Assert.That(button.text, Is.EqualTo(label));
            Assert.That(button.enabledSelf, Is.EqualTo(enabled));
        }

        private static void AssertCenter(Vector2 actual, Vector2 expected, string label) =>
            Assert.That(Vector2.Distance(actual, expected), Is.LessThanOrEqualTo(1.1f), label);

        private static void AssertTextFits(TextElement element)
        {
            Font expectedFont = UnityEditor.AssetDatabase.LoadAssetAtPath<Font>("Assets/Art/UI/Fonts/Oxanium-Bold.ttf");
            Assert.That(element.resolvedStyle.unityFontDefinition.font, Is.SameAs(expectedFont),
                element.name + " must render with Oxanium, not the runtime theme font");
            float width = element.contentRect.width;
            Vector2 measured = element.MeasureTextSize(element.text, width, VisualElement.MeasureMode.AtMost,
                0f, VisualElement.MeasureMode.Undefined);
            Assert.That(measured.x, Is.LessThanOrEqualTo(width + 1f), element.name + " text width");
            Assert.That(measured.y, Is.LessThanOrEqualTo(element.contentRect.height + 1f), element.name + " text height");
        }

        private static void AssertButtonCaptionFitsPaintedFrame(Button button, string sceneName, float scale)
        {
            Vector2 paintedSize = sceneName switch
            {
                "End" when button.name == "try-again-button" => new Vector2(365f, 103f),
                "End" when button.name == "back-to-menu-button" => new Vector2(325f, 103f),
                "End" => new Vector2(352f, 103f),
                "Defeat_Bee" when button.name == "try-again-button" => new Vector2(432f, 110f),
                "Defeat_Bee" => new Vector2(424f, 110f),
                _ when button.name == "try-again-button" => new Vector2(383f, 149f),
                _ => new Vector2(389f, 149f)
            };
            Assert.That(button.resolvedStyle.whiteSpace, Is.EqualTo(WhiteSpace.NoWrap), button.name);
            Vector2 textSize = button.MeasureTextSize(button.text, 0f, VisualElement.MeasureMode.Undefined,
                0f, VisualElement.MeasureMode.Undefined);
            Assert.That(textSize.x, Is.LessThanOrEqualTo(paintedSize.x * scale + 1f), button.name + " painted caption width");
            Assert.That(textSize.y + button.resolvedStyle.paddingTop,
                Is.LessThanOrEqualTo(paintedSize.y * scale + 1f), button.name + " painted caption height");
        }

        private static void Capture(RenderTexture target, string filename)
        {
            RenderTexture previous = RenderTexture.active;
            var image = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
            try
            {
                RenderTexture.active = target;
                image.ReadPixels(new Rect(0f, 0f, target.width, target.height), 0, 0);
                image.Apply();
                string directory = Path.Combine(Path.GetTempPath(), "three-bosses-outcome-toolkit");
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
