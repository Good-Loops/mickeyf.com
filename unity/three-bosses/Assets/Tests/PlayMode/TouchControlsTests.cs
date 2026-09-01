using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.InputSystem.OnScreen;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace ThreeBosses.Tests
{
    public sealed class TouchControlsTests
    {
        private static readonly string[] BattleScenes =
        {
            "Level1_BeeBoss",
            "Level2_CyborgBoss",
            "Level3_Kraken",
        };

        [UnityTest]
        public IEnumerator BattleScenesPreserveKeyboardBindingsAndShareTouchControls()
        {
            foreach (string sceneName in BattleScenes)
            {
                Time.timeScale = 1f;
                DisarmActiveCountdownRestore();
                SceneManager.LoadScene(sceneName);
                yield return null;

                PlayerInput playerInput = FindInActiveScene<PlayerInput>().SingleOrDefault();
                Assert.That(playerInput, Is.Not.Null, $"{sceneName} is missing PlayerInput.");
                AssertInputContract(playerInput.actions);

                Type visibilityType = Type.GetType(
                    "TouchControlsVisibility, Assembly-CSharp");
                Assert.That(visibilityType, Is.Not.Null);
                Component[] visibilityControllers = SceneManager.GetActiveScene()
                    .GetRootGameObjects()
                    .Select(root => root.GetComponent(visibilityType))
                    .Where(component => component != null)
                    .ToArray();
                Assert.That(
                    visibilityControllers,
                    Has.Length.EqualTo(1),
                    $"{sceneName} must contain exactly one touch HUD.");
                AssertTouchHudLayout(visibilityControllers[0], sceneName);

                OnScreenStick[] sticks = FindInActiveScene<OnScreenStick>();
                Assert.That(sticks, Has.Length.EqualTo(1));
                Assert.That(sticks[0].controlPath, Is.EqualTo("<Gamepad>/leftStick"));

                string[] buttonPaths = FindInActiveScene<OnScreenButton>()
                    .Select(button => button.controlPath)
                    .OrderBy(path => path)
                    .ToArray();
                Assert.That(
                    buttonPaths,
                    Is.EqualTo(new[]
                    {
                        "<Gamepad>/buttonEast",
                        "<Gamepad>/buttonSouth",
                        "<Gamepad>/buttonWest",
                    }));

                EventSystem[] eventSystems = FindInActiveScene<EventSystem>();
                Assert.That(eventSystems, Has.Length.EqualTo(1));
                Assert.That(eventSystems[0].GetComponent<InputSystemUIInputModule>(), Is.Not.Null);

                Type pauseControllerType = Type.GetType(
                    "GameplayPauseController, Assembly-CSharp");
                Assert.That(pauseControllerType, Is.Not.Null);
                Component[] pauseControllers = SceneManager.GetActiveScene()
                    .GetRootGameObjects()
                    .SelectMany(root => root.GetComponentsInChildren(pauseControllerType, true))
                    .ToArray();
                Assert.That(
                    pauseControllers,
                    Has.Length.EqualTo(1),
                    $"{sceneName} must contain exactly one gameplay pause controller.");

                FieldInfo pauseMenuField = pauseControllerType.GetField(
                    "pauseMenu",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                FieldInfo playerInputField = pauseControllerType.GetField(
                    "playerInput",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                Assert.That(pauseMenuField, Is.Not.Null);
                Assert.That(playerInputField, Is.Not.Null);

                CanvasGroup pauseMenu = pauseMenuField.GetValue(pauseControllers[0]) as CanvasGroup;
                Assert.That(pauseMenu, Is.Not.Null);
                Assert.That(pauseMenu.alpha, Is.EqualTo(0f));
                Assert.That(pauseMenu.interactable, Is.False);
                Assert.That(pauseMenu.blocksRaycasts, Is.False);
                Assert.That(playerInputField.GetValue(pauseControllers[0]), Is.SameAs(playerInput));
            }
        }

        [UnityTest]
        public IEnumerator TouchHudRequiresHostPermissionAcrossBattleScenes()
        {
            Time.timeScale = 1f;
            DisarmActiveCountdownRestore();
            SceneManager.LoadScene(BattleScenes[0]);
            yield return null;

            Type visibilityType = Type.GetType("TouchControlsVisibility, Assembly-CSharp");
            Assert.That(visibilityType, Is.Not.Null);
            Component visibility = SceneManager.GetActiveScene()
                .GetRootGameObjects()
                .Select(root => root.GetComponent(visibilityType))
                .Single(component => component != null);
            Assert.That(visibility, Is.Not.Null);

            FieldInfo controlsRootField = visibilityType.GetField(
                "controlsRoot",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(controlsRootField, Is.Not.Null);
            GameObject controlsRoot = controlsRootField.GetValue(visibility) as GameObject;
            Assert.That(controlsRoot, Is.Not.Null);
            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            Assert.That(serviceType, Is.Not.Null);
            PropertyInfo serviceInstance = serviceType.GetProperty(
                "Instance",
                BindingFlags.Static | BindingFlags.Public);
            Assert.That(serviceInstance, Is.Not.Null);
            Component service = serviceInstance.GetValue(null) as Component;
            Assert.That(service, Is.Not.Null);
            MethodInfo configureTouchControls = serviceType.GetMethod(
                "ConfigureTouchControls",
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(configureTouchControls, Is.Not.Null);
            Assert.That(controlsRoot.activeSelf, Is.False);

            configureTouchControls.Invoke(service, new object[] { "1" });
            Assert.That(controlsRoot.activeSelf, Is.True);
            configureTouchControls.Invoke(service, new object[] { "1" });
            Assert.That(controlsRoot.activeSelf, Is.True);

            DisarmActiveCountdownRestore();
            SceneManager.LoadScene(BattleScenes[1]);
            yield return null;

            Component nextVisibility = SceneManager.GetActiveScene()
                .GetRootGameObjects()
                .Select(root => root.GetComponent(visibilityType))
                .Single(component => component != null);
            GameObject nextControlsRoot = controlsRootField.GetValue(nextVisibility) as GameObject;
            Assert.That(nextControlsRoot, Is.Not.Null);
            Assert.That(
                nextControlsRoot.activeSelf,
                Is.True,
                "The persistent browser permission must survive scene changes.");

            configureTouchControls.Invoke(service, new object[] { "0" });
            Assert.That(nextControlsRoot.activeSelf, Is.False);

            DisarmActiveCountdownRestore();
            SceneManager.LoadScene(BattleScenes[2]);
            yield return null;

            Component finalVisibility = SceneManager.GetActiveScene()
                .GetRootGameObjects()
                .Select(root => root.GetComponent(visibilityType))
                .Single(component => component != null);
            GameObject finalControlsRoot = controlsRootField.GetValue(finalVisibility) as GameObject;
            Assert.That(finalControlsRoot, Is.Not.Null);
            Assert.That(
                finalControlsRoot.activeSelf,
                Is.False,
                "Disabled touch permission must survive the final scene transition.");

            configureTouchControls.Invoke(service, new object[] { "invalid" });
            Assert.That(finalControlsRoot.activeSelf, Is.False);
        }

        [Test]
        public void TouchSafeAreaNormalizesFullScreenAndAsymmetricInsets()
        {
            Type layoutType = Type.GetType("TouchSafeAreaLayout, Assembly-CSharp");
            Assert.That(layoutType, Is.Not.Null);
            MethodInfo calculateAnchors = layoutType.GetMethod(
                "CalculateAnchors",
                BindingFlags.Static | BindingFlags.NonPublic);
            Assert.That(calculateAnchors, Is.Not.Null);

            AssertAnchors(
                calculateAnchors,
                new Rect(0f, 0f, 1280f, 720f),
                new Vector2(1280f, 720f),
                new Rect(0f, 0f, 1f, 1f));
            AssertAnchors(
                calculateAnchors,
                new Rect(80f, 0f, 1200f, 720f),
                new Vector2(1280f, 720f),
                Rect.MinMaxRect(0.0625f, 0f, 1f, 1f));
            AssertAnchors(
                calculateAnchors,
                new Rect(0f, 40f, 720f, 1240f),
                new Vector2(720f, 1280f),
                Rect.MinMaxRect(0f, 0.03125f, 1f, 1f));
        }

        [Test]
        public void PauseButtonTracksTheSafeAreaTopRightCorner()
        {
            Type pauseControllerType = Type.GetType("GameplayPauseController, Assembly-CSharp");
            Assert.That(pauseControllerType, Is.Not.Null);
            MethodInfo applySafeArea = pauseControllerType.GetMethod(
                "ApplyTopRightSafeArea",
                BindingFlags.Static | BindingFlags.NonPublic);
            Assert.That(applySafeArea, Is.Not.Null);

            var button = new GameObject("Pause Button", typeof(RectTransform));
            try
            {
                RectTransform rect = button.GetComponent<RectTransform>();
                rect.pivot = Vector2.one;
                rect.sizeDelta = new Vector2(48f, 40f);
                rect.anchoredPosition = new Vector2(-24f, -54f);
                var safeArea = new Rect(0f, 0f, 1200f, 680f);
                var screenSize = new Vector2(1280f, 720f);
                applySafeArea.Invoke(
                    null,
                    new object[]
                    {
                        rect,
                        safeArea,
                        screenSize
                    });

                var expected = new Vector2(0.9375f, 0.9444444f);
                Assert.That(rect.anchorMin.x, Is.EqualTo(expected.x).Within(0.0001f));
                Assert.That(rect.anchorMin.y, Is.EqualTo(expected.y).Within(0.0001f));
                Assert.That(rect.anchorMax.x, Is.EqualTo(expected.x).Within(0.0001f));
                Assert.That(rect.anchorMax.y, Is.EqualTo(expected.y).Within(0.0001f));
                Assert.That(rect.anchoredPosition, Is.EqualTo(new Vector2(-24f, -54f)));

                Vector2 anchorPoint = Vector2.Scale(rect.anchorMin, screenSize);
                Vector2 elementMinimum = anchorPoint + rect.anchoredPosition -
                    Vector2.Scale(rect.pivot, rect.sizeDelta);
                Vector2 elementMaximum = elementMinimum + rect.sizeDelta;
                Assert.That(elementMinimum.x, Is.GreaterThanOrEqualTo(safeArea.xMin));
                Assert.That(elementMinimum.y, Is.GreaterThanOrEqualTo(safeArea.yMin));
                Assert.That(elementMaximum.x, Is.LessThanOrEqualTo(safeArea.xMax));
                Assert.That(elementMaximum.y, Is.LessThanOrEqualTo(safeArea.yMax));
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(button);
            }
        }

        [Test]
        public void AimResolutionKeepsDesktopPriorityAndLastDirection()
        {
            Type weaponType = Type.GetType("PlayerWeaponController, Assembly-CSharp");
            Type aimType = Type.GetType("AimDir, Assembly-CSharp");
            Assert.That(weaponType, Is.Not.Null);
            Assert.That(aimType, Is.Not.Null);

            MethodInfo resolver = weaponType.GetMethod(
                "ResolveAimDirection",
                BindingFlags.Static | BindingFlags.NonPublic,
                null,
                new[] { typeof(bool), typeof(bool), typeof(bool), aimType },
                null);
            Assert.That(resolver, Is.Not.Null);

            object front = Enum.Parse(aimType, "Front");
            object back = Enum.Parse(aimType, "Back");
            object up = Enum.Parse(aimType, "Up");

            Assert.That(Resolve(resolver, true, true, true, front), Is.EqualTo(up));
            Assert.That(Resolve(resolver, false, true, true, front), Is.EqualTo(back));
            Assert.That(Resolve(resolver, false, false, true, back), Is.EqualTo(front));
            Assert.That(Resolve(resolver, false, false, false, back), Is.EqualTo(back));
        }

        [UnityTest]
        public IEnumerator FireActionRequiresReleaseBeforeAnotherPress()
        {
            Time.timeScale = 1f;
            DisarmActiveCountdownRestore();
            SceneManager.LoadScene(BattleScenes[0]);
            yield return null;

            PlayerInput playerInput = FindInActiveScene<PlayerInput>().Single();
            playerInput.enabled = false;
            InputAction fire = playerInput.actions.FindAction("Gameplay/Fire", true);
            Gamepad gamepad = InputSystem.AddDevice<Gamepad>();
            int performedCount = 0;

            void CountPerformed(InputAction.CallbackContext _) => performedCount++;

            try
            {
                playerInput.actions.devices = new InputDevice[] { gamepad };
                fire.performed += CountPerformed;
                fire.Enable();

                InputSystem.QueueStateEvent(
                    gamepad,
                    new GamepadState().WithButton(GamepadButton.West));
                InputSystem.Update();
                Assert.That(performedCount, Is.EqualTo(1));

                InputSystem.QueueStateEvent(
                    gamepad,
                    new GamepadState().WithButton(GamepadButton.West));
                InputSystem.Update();
                Assert.That(
                    performedCount,
                    Is.EqualTo(1),
                    "Holding Fire must not repeatedly dispatch presses.");

                InputSystem.QueueStateEvent(gamepad, new GamepadState());
                InputSystem.Update();
                InputSystem.QueueStateEvent(
                    gamepad,
                    new GamepadState().WithButton(GamepadButton.West));
                InputSystem.Update();
                Assert.That(performedCount, Is.EqualTo(2));
            }
            finally
            {
                fire.performed -= CountPerformed;
                fire.Disable();
                if (gamepad.added)
                    InputSystem.RemoveDevice(gamepad);
            }
        }

        [UnityTearDown]
        public IEnumerator RestoreNeutralScene()
        {
            Time.timeScale = 1f;
            DisarmActiveCountdownRestore();
            SceneManager.LoadScene("MainMenu", LoadSceneMode.Single);
            yield return null;

            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            if (serviceType == null)
                yield break;

            MonoBehaviour service = UnityEngine.Object.FindFirstObjectByType(serviceType) as MonoBehaviour;
            if (service != null)
            {
                UnityEngine.Object.Destroy(service.gameObject);
                yield return null;
            }
        }

        private static object Resolve(
            MethodInfo resolver,
            bool aimUp,
            bool aimBack,
            bool aimFront,
            object currentAim)
        {
            return resolver.Invoke(null, new[] { (object)aimUp, aimBack, aimFront, currentAim });
        }

        private static void AssertTouchHudLayout(Component visibility, string sceneName)
        {
            Transform controls = visibility.transform.Find("Touch HUD/Controls");
            Assert.That(controls, Is.Not.Null, $"{sceneName} is missing the touch controls root.");

            RectTransform controlsRect = controls as RectTransform;
            Assert.That(controlsRect.anchorMin, Is.EqualTo(Vector2.zero), sceneName);
            Assert.That(controlsRect.anchorMax, Is.EqualTo(Vector2.one), sceneName);

            Type layoutType = Type.GetType("TouchSafeAreaLayout, Assembly-CSharp");
            Assert.That(layoutType, Is.Not.Null);
            Component layout = controls.parent.GetComponent(layoutType);
            Assert.That(layout, Is.Not.Null, $"{sceneName} is missing safe-area layout.");
            FieldInfo controlsRootField = layoutType.GetField(
                "controlsRoot",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(controlsRootField, Is.Not.Null);
            Assert.That(controlsRootField.GetValue(layout), Is.SameAs(controlsRect));

            AssertGlassControl(
                controls.Find("Movement Stick"),
                new Vector2(96f, 96f),
                new Vector2(90f, 90f),
                0.085f,
                0.10f,
                false,
                sceneName);
            Transform handle = controls.Find("Movement Stick/Handle");
            Assert.That(((RectTransform)handle).sizeDelta, Is.EqualTo(new Vector2(38f, 38f)), sceneName);
            Assert.That(handle.GetComponent<Image>().raycastPadding, Is.EqualTo(new Vector4(-40f, -40f, -40f, -40f)), sceneName);
            Assert.That(handle.GetComponent<Image>().color.a, Is.EqualTo(0.28f).Within(0.001f), sceneName);
            Assert.That(handle.GetComponent<OnScreenStick>().movementRange, Is.EqualTo(29f), sceneName);

            AssertGlassControl(
                controls.Find("Jump Button"),
                new Vector2(64f, 64f),
                new Vector2(58f, 58f),
                0.085f,
                0.10f,
                true,
                sceneName);
            AssertGlassControl(
                controls.Find("Dash Button"),
                new Vector2(64f, 64f),
                new Vector2(58f, 58f),
                0.085f,
                0.10f,
                true,
                sceneName);
            AssertGlassControl(
                controls.Find("Fire Button"),
                new Vector2(72f, 72f),
                new Vector2(66f, 66f),
                0.11f,
                0.12f,
                true,
                sceneName);
        }

        private static void AssertGlassControl(
            Transform control,
            Vector2 visibleSize,
            Vector2 surfaceSize,
            float rimAlpha,
            float surfaceAlpha,
            bool acceptsRaycasts,
            string sceneName)
        {
            Assert.That(control, Is.Not.Null, sceneName);
            Assert.That(((RectTransform)control).sizeDelta, Is.EqualTo(visibleSize), sceneName);

            Image rim = control.GetComponent<Image>();
            Assert.That(rim, Is.Not.Null, sceneName);
            Assert.That(rim.raycastTarget, Is.EqualTo(acceptsRaycasts), sceneName);
            Assert.That(rim.color.a, Is.EqualTo(rimAlpha).Within(0.001f), sceneName);
            Assert.That(control.GetComponent<Outline>(), Is.Null, sceneName);

            Transform surface = control.Find("Surface");
            Assert.That(surface, Is.Not.Null, sceneName);
            Assert.That(((RectTransform)surface).sizeDelta, Is.EqualTo(surfaceSize), sceneName);
            Image surfaceImage = surface.GetComponent<Image>();
            Assert.That(surfaceImage, Is.Not.Null, sceneName);
            Assert.That(surfaceImage.raycastTarget, Is.False, sceneName);
            Assert.That(surfaceImage.color.a, Is.EqualTo(surfaceAlpha).Within(0.001f), sceneName);

            if (acceptsRaycasts)
                Assert.That(rim.raycastPadding, Is.EqualTo(new Vector4(-20f, -20f, -20f, -20f)), sceneName);
        }

        private static void AssertAnchors(
            MethodInfo calculateAnchors,
            Rect safeArea,
            Vector2 screenSize,
            Rect expected)
        {
            Rect actual = (Rect)calculateAnchors.Invoke(null, new object[] { safeArea, screenSize });
            Assert.That(actual.xMin, Is.EqualTo(expected.xMin).Within(0.0001f));
            Assert.That(actual.yMin, Is.EqualTo(expected.yMin).Within(0.0001f));
            Assert.That(actual.xMax, Is.EqualTo(expected.xMax).Within(0.0001f));
            Assert.That(actual.yMax, Is.EqualTo(expected.yMax).Within(0.0001f));
        }

        private static void AssertInputContract(InputActionAsset actions)
        {
            Assert.That(actions, Is.Not.Null);
            InputActionMap gameplay = actions.FindActionMap("Gameplay", true);
            InputAction move = gameplay.FindAction("Move", true);
            InputAction jump = gameplay.FindAction("Jump", true);
            InputAction dash = gameplay.FindAction("Dash", true);
            InputAction aimUp = gameplay.FindAction("AimUp", true);
            InputAction aimBack = gameplay.FindAction("AimBack", true);
            InputAction aimFront = gameplay.FindAction("AimFront", true);
            InputAction fire = gameplay.FindAction("Fire", true);

            AssertBinding(move, "<Keyboard>/a");
            AssertBinding(move, "<Keyboard>/d");
            AssertBinding(move, "<Keyboard>/leftArrow");
            AssertBinding(move, "<Keyboard>/rightArrow");
            AssertBinding(move, "<Gamepad>/leftStick");
            AssertBinding(jump, "<Keyboard>/space");
            AssertBinding(jump, "<Gamepad>/buttonSouth");
            AssertBinding(dash, "<Keyboard>/leftShift");
            AssertBinding(dash, "<Gamepad>/buttonEast");
            AssertBinding(aimUp, "<Keyboard>/w");
            AssertBinding(aimUp, "<Gamepad>/leftStick/up");
            AssertBinding(aimBack, "<Keyboard>/a");
            AssertBinding(aimBack, "<Gamepad>/leftStick/left");
            AssertBinding(aimFront, "<Keyboard>/d");
            AssertBinding(aimFront, "<Gamepad>/leftStick/right");
            foreach (InputAction aim in new[] { aimUp, aimBack, aimFront })
            {
                Assert.That(aim.type, Is.EqualTo(InputActionType.Value));
                Assert.That(aim.wantsInitialStateCheck, Is.True);
            }
            Assert.That(
                new[] { aimUp, aimBack, aimFront }
                    .SelectMany(action => action.bindings)
                    .Any(binding => binding.path.Contains("Arrow")),
                Is.False,
                "Arrow keys must never become aim controls.");
            AssertBinding(fire, "<Keyboard>/enter");
            AssertBinding(fire, "<Gamepad>/buttonWest");
            Assert.That(fire.type, Is.EqualTo(InputActionType.Button));
            Assert.That(fire.interactions, Is.EqualTo("Press"));
            Assert.That(fire.wantsInitialStateCheck, Is.False);
            Assert.That(
                fire.bindings.All(binding => string.IsNullOrEmpty(binding.interactions)),
                Is.True,
                "Fire bindings must not add release or hold interactions.");
        }

        private static T[] FindInActiveScene<T>() where T : Component
        {
            return SceneManager.GetActiveScene()
                .GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<T>(true))
                .ToArray();
        }

        private static void DisarmActiveCountdownRestore()
        {
            // Scene teardown destroys boss targets before the countdown's
            // OnDisable callback runs. Keep test cleanup from re-enabling a
            // half-destroyed boss hierarchy.
            Type countdownType = Type.GetType("RunCountdownController, Assembly-CSharp");
            FieldInfo ownsGameplayGate = countdownType?.GetField(
                "ownsGameplayGate",
                BindingFlags.Instance | BindingFlags.NonPublic);
            if (countdownType == null || ownsGameplayGate == null)
                return;

            foreach (MonoBehaviour behaviour in FindInActiveScene<MonoBehaviour>())
            {
                if (behaviour.GetType() == countdownType)
                    ownsGameplayGate.SetValue(behaviour, false);
            }
        }

        private static void AssertBinding(InputAction action, string path)
        {
            Assert.That(
                action.bindings.Any(binding => binding.path == path),
                Is.True,
                $"{action.name} is missing {path}.");
        }
    }
}
