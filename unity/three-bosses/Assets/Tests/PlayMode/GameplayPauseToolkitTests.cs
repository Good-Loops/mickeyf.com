#if UNITY_EDITOR
using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace ThreeBosses.Tests
{
    [Category("ScreenUI")]
    public sealed class GameplayPauseToolkitTests
    {
        private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
        private static readonly string[] BattleScenes = { "Level1_BeeBoss", "Level2_CyborgBoss", "Level3_Kraken" };
        private Component controller;
        private Component service;
        private UIDocument document;
        private PlayerInput playerInput;
        private Keyboard keyboard;

        [UnityTest]
        public IEnumerator PauseResumePreservesInputTimeScaleAndClearsKeyboardSelection()
        {
            yield return LoadBattle(BattleScenes[0]);
            var opener = document.rootVisualElement.Q<Button>("pause-open");
            Assert.That(opener.focusable, Is.False);
            Assert.That(opener.tabIndex, Is.EqualTo(-1));
            Time.timeScale = 0.75f;

            Invoke(controller, "TogglePause");
            yield return null;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.True);
            Assert.That(Time.timeScale, Is.Zero);
            Assert.That(playerInput.enabled, Is.False);
            Assert.That(document.rootVisualElement.panel.focusController.focusedElement,
                Is.SameAs(document.rootVisualElement.Q<Button>("pause-resume")));
            // Toolkit selects its routing GameObject while a VisualElement has keyboard focus.
            var panelHandler = EventSystem.current.currentSelectedGameObject?.GetComponent<PanelEventHandler>();
            Assert.That(panelHandler, Is.Not.Null);
            Assert.That(panelHandler.panel, Is.SameAs(document.rootVisualElement.panel));

            Submit(document.rootVisualElement.Q<Button>("pause-resume"));
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(Time.timeScale, Is.EqualTo(0.75f));
            Assert.That(playerInput.enabled, Is.True);
            AssertCollapsedAndUnfocused();

            // Even a stale explicit Submit must not activate this pointer-only opener.
            Submit(opener);
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False);
            keyboard = InputSystem.AddDevice<Keyboard>("Pause test keyboard");
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(Key.Enter));
            yield return null;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False, "Gameplay Fire must not reopen pause.");
            InputSystem.QueueStateEvent(keyboard, new KeyboardState());
            yield return null;

            InputSystem.QueueStateEvent(keyboard, new KeyboardState(Key.Escape));
            yield return null;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.True, "Escape must open pause.");
            InputSystem.QueueStateEvent(keyboard, new KeyboardState());
            yield return null;
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(Key.Escape));
            yield return null;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False, "Escape must resume.");
            InputSystem.QueueStateEvent(keyboard, new KeyboardState());
            yield return null;

            playerInput.enabled = false;
            Invoke(controller, "TogglePause");
            Invoke(controller, "ResumeGameplay");
            Assert.That(playerInput.enabled, Is.False, "Pause must preserve an input gate owned by another system.");
            AssertCollapsedAndUnfocused();
        }

        [UnityTest]
        public IEnumerator BrowserSuspensionComposesWithPauseAndControllerDisableRestoresOnlyItsOwnGate()
        {
            yield return LoadBattle(BattleScenes[0]);
            AudioListener.pause = false;
            Invoke(controller, "TogglePause");
            Invoke(service, "PauseForDocumentHidden");
            Invoke(controller, "ResumeGameplay");
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(Get<bool>(service, "IsPausedForDocumentHidden"), Is.True);
            Assert.That(AudioListener.pause, Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Invoke(controller, "TogglePause");
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False, "Hidden documents cannot start user pause.");
            Invoke(service, "ResumeFromDocumentHidden");
            Assert.That(AudioListener.pause, Is.False);

            Invoke(controller, "TogglePause");
            Invoke(service, "PauseForDocumentHidden");
            Invoke(service, "ResumeFromDocumentHidden");
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.True);
            Assert.That(Time.timeScale, Is.Zero);
            Assert.That(playerInput.enabled, Is.False);

            Invoke(service, "PauseForDocumentHidden");
            ((Behaviour)controller).enabled = false;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(Get<bool>(service, "IsPausedForDocumentHidden"), Is.True);
            Assert.That(AudioListener.pause, Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(playerInput.enabled, Is.True);
            AssertCollapsedAndUnfocused();
            Invoke(service, "ResumeFromDocumentHidden");

            ((Behaviour)controller).enabled = true;
            Invoke(controller, "TogglePause");
            yield return null;
            yield return null;
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.True);
            Submit(document.rootVisualElement.Q<Button>("pause-main-menu"));
            yield return null;
            Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("MainMenu"));
            Assert.That(Get<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(Time.timeScale, Is.EqualTo(1f));
        }

        [UnityTest]
        public IEnumerator AllBattleScenesKeepPauseTargetsInsideSafeAreasAndBlockOnlyWhileOpen()
        {
            foreach (string sceneName in BattleScenes)
            {
                yield return LoadBattle(sceneName);
                var productionPanel = document.panelSettings;
                Assert.That(productionPanel.scaleMode, Is.EqualTo(PanelScaleMode.ConstantPixelSize));
                Assert.That(productionPanel.scale, Is.EqualTo(1f));
                foreach (Canvas canvas in FindInScene<Canvas>())
                    Assert.That(productionPanel.sortingOrder, Is.GreaterThan(canvas.sortingOrder));
                // The game overlay must preserve the camera below it; isolated RT captures must clear old pixels.
                var capturePanel = UnityEngine.Object.Instantiate(productionPanel);
                capturePanel.clearColor = true;
                capturePanel.colorClearValue = Color.clear;
                document.panelSettings = capturePanel;
                RenderTexture target = null;
                var sizes = new[] { new Vector2Int(390, 844), new(844, 390), new(768, 1024), new(1280, 720) };
                try
                {
                    foreach (Vector2Int size in sizes)
                    {
                        if (target != null) UnityEngine.Object.Destroy(target);
                        target = new RenderTexture(size.x, size.y, 24);
                        target.Create();
                        capturePanel.targetTexture = target;
                        yield return null;
                        yield return null;
                        Rect viewport = new(0, 0, size.x, size.y);
                        Rect safe = size.x == 390 ? new Rect(0, 47, 390, 763)
                            : size.x == 844 ? new Rect(47, 0, 750, 369)
                            : size.x == 768 ? new Rect(0, 20, 768, 984) : viewport;
                        Invoke(controller, "UpdateLayout", viewport, safe);
                        yield return null;
                        yield return null;
                        var root = document.rootVisualElement;
                        var opener = root.Q<Button>("pause-open");
                        AssertTargetInside(opener, safe);
                        Assert.That(root.panel.Pick(opener.worldBound.center), Is.SameAs(opener));
                        Vector2 clearPoint = new(8, size.y - 8);
                        VisualElement picked = root.panel.Pick(clearPoint);
                        Assert.That(picked == null || !root.Contains(picked), Is.True,
                            "Collapsed decorative pause UI must not consume gameplay or page touches.");

                        Invoke(controller, "TogglePause");
                        yield return null;
                        yield return null;
                        Assert.That(root.Q("pause-overlay").resolvedStyle.display, Is.EqualTo(DisplayStyle.Flex));
                        Assert.That(root.panel.Pick(clearPoint), Is.SameAs(root.Q("pause-overlay")));
                        Assert.That(Vector2.Distance(root.Q("pause-panel").worldBound.center, safe.center),
                            Is.LessThanOrEqualTo(1f));
                        AssertTargetInside(root.Q<Button>("pause-resume"), safe);
                        AssertTargetInside(root.Q<Button>("pause-main-menu"), safe);
                        Assert.That(root.Q("pause-title").pickingMode, Is.EqualTo(PickingMode.Ignore));
                        if (size.x == 390 || size.x == 1280)
                            Capture(target, $"{sceneName}-pause-{size.x}x{size.y}.png");
                        Invoke(controller, "ResumeGameplay");
                        yield return null;
                    }
                }
                finally
                {
                    document.panelSettings = productionPanel;
                    UnityEngine.Object.Destroy(capturePanel);
                    if (target != null) UnityEngine.Object.Destroy(target);
                }
            }
        }

        private IEnumerator LoadBattle(string sceneName)
        {
            DisarmCountdown();
            Time.timeScale = 1f;
            SceneManager.LoadScene(sceneName);
            yield return null;
            DisarmCountdown();
            service = (Component)RuntimeType("RunSessionService").GetProperty("Instance").GetValue(null);
            Invoke(service, "ResumeFromDocumentHidden");
            Invoke(service, "ResumeFromUserPause");
            object session = Get<object>(service, "Session");
            Invoke(session, "BeginNewRun");
            Assert.That((bool)Invoke(session, "StartRun"), Is.True);
            foreach (string name in new[] { "BossController", "PlayerWeaponController" })
                foreach (Behaviour behaviour in FindInScene(RuntimeType(name)))
                    behaviour.enabled = false;
            playerInput = FindInScene<PlayerInput>().Single();
            playerInput.enabled = true;
            controller = FindInScene(RuntimeType("GameplayPauseController")).Single();
            document = controller.GetComponent<UIDocument>();
            Assert.That(((Behaviour)controller).enabled, Is.True);
            Assert.That(document, Is.Not.Null);
            Time.timeScale = 1f;
            yield return null;
            yield return null;
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            if (keyboard != null && keyboard.added) InputSystem.RemoveDevice(keyboard);
            keyboard = null;
            if (service != null)
            {
                Invoke(service, "ResumeFromDocumentHidden");
                Invoke(service, "ResumeFromUserPause");
            }
            DisarmCountdown();
            Time.timeScale = 1f;
            SceneManager.LoadScene("MainMenu");
            yield return null;
            if (service != null) UnityEngine.Object.Destroy(service.gameObject);
            yield return null;
            controller = null;
            service = null;
        }

        private void AssertCollapsedAndUnfocused()
        {
            Assert.That(document.rootVisualElement.Q("pause-overlay").style.display.value, Is.EqualTo(DisplayStyle.None));
            Assert.That(document.rootVisualElement.panel.focusController.focusedElement, Is.Null);
            Assert.That(EventSystem.current.currentSelectedGameObject, Is.Null);
        }

        private static void AssertTargetInside(Button button, Rect safe)
        {
            Rect bounds = button.worldBound;
            Assert.That(bounds.width, Is.GreaterThanOrEqualTo(47.5f), button.name);
            Assert.That(bounds.height, Is.GreaterThanOrEqualTo(47.5f), button.name);
            Assert.That(bounds.xMin, Is.GreaterThanOrEqualTo(safe.xMin - 1f), button.name);
            Assert.That(bounds.yMin, Is.GreaterThanOrEqualTo(safe.yMin - 1f), button.name);
            Assert.That(bounds.xMax, Is.LessThanOrEqualTo(safe.xMax + 1f), button.name);
            Assert.That(bounds.yMax, Is.LessThanOrEqualTo(safe.yMax + 1f), button.name);
        }

        private static void Submit(Button button)
        {
            if (button.focusable)
            {
                button.Focus();
                Assert.That(button.panel.focusController.focusedElement, Is.SameAs(button));
            }
            using var submit = NavigationSubmitEvent.GetPooled();
            button.SendEvent(submit);
        }

        private static void DisarmCountdown()
        {
            Type countdownType = RuntimeType("RunCountdownController");
            foreach (Behaviour countdown in FindInScene(countdownType))
            {
                countdownType.GetField("ownsGameplayGate", PrivateInstance).SetValue(countdown, false);
                countdown.enabled = false;
            }
        }

        private static T[] FindInScene<T>() where T : Component => SceneManager.GetActiveScene()
            .GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<T>(true)).ToArray();

        private static Component[] FindInScene(Type type) => SceneManager.GetActiveScene()
            .GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren(type, true)).ToArray();

        private static Type RuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, name);
            return type;
        }

        private static object Invoke(object target, string method, params object[] arguments) =>
            target.GetType().GetMethod(method).Invoke(target, arguments);

        private static T Get<T>(object target, string property) =>
            (T)target.GetType().GetProperty(property).GetValue(target);

        private static void Capture(RenderTexture target, string filename)
        {
            RenderTexture previous = RenderTexture.active;
            var image = new Texture2D(target.width, target.height, TextureFormat.RGBA32, false);
            try
            {
                RenderTexture.active = target;
                image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                image.Apply();
                string directory = Path.Combine(Path.GetTempPath(), "three-bosses-screen-ui");
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
