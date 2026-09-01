using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace ThreeBosses.Tests
{
    public sealed class UiPresentationTests
    {
        [UnityTest]
        public IEnumerator ButtonStyleIsIdempotentAndSelectionScalesOnlyTheLabel()
        {
            GameObject eventSystemObject = null;
            EventSystem eventSystem = EventSystem.current;
            if (eventSystem == null)
            {
                eventSystemObject = new GameObject("Test EventSystem", typeof(EventSystem));
                eventSystem = eventSystemObject.GetComponent<EventSystem>();
            }

            GameObject buttonObject = new(
                "Test Button",
                typeof(RectTransform),
                typeof(CanvasRenderer),
                typeof(Image),
                typeof(Button));
            Button button = buttonObject.GetComponent<Button>();
            Image hitArea = buttonObject.GetComponent<Image>();

            GameObject labelObject = new("Label", typeof(RectTransform), typeof(CanvasRenderer));
            labelObject.transform.SetParent(buttonObject.transform, false);
            Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            Graphic label = labelObject.AddComponent(textType) as Graphic;
            Assert.That(label, Is.Not.Null);

            Color accent = new(1f, 0.12f, 0.08f, 0.32f);
            ColorBlock initialColors = button.colors;
            initialColors.highlightedColor = accent;
            button.colors = initialColors;

            Type styleType = RequireType("UiButtonStyle, Assembly-CSharp");
            MethodInfo applyStyle = RequireMethod(styleType, "Apply");
            applyStyle.Invoke(null, new object[] { button });
            Color firstFocusedColor = button.colors.highlightedColor;
            Color firstPressedColor = button.colors.pressedColor;

            applyStyle.Invoke(null, new object[] { button });

            Assert.That(hitArea.color, Is.EqualTo(Color.clear));
            Assert.That(hitArea.raycastTarget, Is.True);
            Assert.That(button.targetGraphic, Is.SameAs(label));
            Assert.That(label.raycastTarget, Is.False);
            Assert.That(button.colors.highlightedColor, Is.EqualTo(firstFocusedColor));
            Assert.That(button.colors.pressedColor, Is.EqualTo(firstPressedColor));
            Assert.That(button.colors.selectedColor, Is.EqualTo(button.colors.normalColor));

            Type feedbackType = RequireType("ButtonHoverFeedback, Assembly-CSharp");
            Component feedback = button.GetComponent(feedbackType);
            Assert.That(feedback, Is.Not.Null);
            Assert.That(GetProperty<bool>(feedback, "HasConfiguredAccent"), Is.True);
            Assert.That(
                GetProperty<Color>(feedback, "AccentColor"),
                Is.EqualTo(new Color(accent.r, accent.g, accent.b, 1f)));

            PointerEventData pointerData = new(eventSystem);
            button.OnPointerEnter(pointerData);
            RequireMethod(feedbackType, "OnPointerEnter").Invoke(
                feedback,
                new object[] { pointerData });
            yield return new WaitForSecondsRealtime(0.12f);

            Assert.That(
                label.canvasRenderer.GetColor(),
                Is.Not.EqualTo(button.colors.normalColor));
            Assert.That(label.transform.localScale.x, Is.GreaterThan(1.03f));
            Assert.That(buttonObject.transform.localScale, Is.EqualTo(Vector3.one));

            button.OnPointerExit(pointerData);
            RequireMethod(feedbackType, "OnPointerExit").Invoke(
                feedback,
                new object[] { pointerData });
            yield return new WaitForSecondsRealtime(0.12f);
            Assert.That(label.transform.localScale.x, Is.EqualTo(1f).Within(0.01f));
            AssertColorApproximately(label.canvasRenderer.GetColor(), button.colors.normalColor);

            eventSystem.SetSelectedGameObject(buttonObject);
            yield return new WaitForSecondsRealtime(0.12f);
            Assert.That(label.transform.localScale.x, Is.GreaterThan(1.02f));
            Assert.That(buttonObject.transform.localScale, Is.EqualTo(Vector3.one));
            AssertColorApproximately(label.canvasRenderer.GetColor(), button.colors.normalColor);

            eventSystem.SetSelectedGameObject(null);
            yield return new WaitForSecondsRealtime(0.12f);
            Assert.That(label.transform.localScale.x, Is.EqualTo(1f).Within(0.01f));

            button.interactable = false;
            RequireMethod(feedbackType, "OnPointerEnter").Invoke(feedback, new object[] { null });
            yield return null;
            Assert.That(label.transform.localScale, Is.EqualTo(Vector3.one));

            UnityEngine.Object.Destroy(buttonObject);
            if (eventSystemObject != null)
                UnityEngine.Object.Destroy(eventSystemObject);
        }

        [UnityTest]
        public IEnumerator MainMenuAudioButtonUsesStatefulIconAndRestoresItsSavedPreference()
        {
            SceneManager.LoadScene("MainMenu");
            yield return null;

            Button audioButton = UnityEngine.Object.FindObjectsByType<Button>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None)
                .Single(button => button.gameObject.name == "Audio Button");
            Assert.That(audioButton, Is.Not.Null);

            Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            Assert.That(audioButton.GetComponentsInChildren(textType, true), Is.Empty);

            Type iconType = RequireType("AudioToggleIcon, Assembly-CSharp");
            Component icon = audioButton.GetComponentInChildren(iconType, true);
            Assert.That(icon, Is.Not.Null);
            Assert.That(audioButton.targetGraphic, Is.SameAs(icon));
            Assert.That(audioButton.targetGraphic.raycastTarget, Is.False);
            Assert.That(audioButton.GetComponent<Image>().raycastTarget, Is.True);
            Assert.That(audioButton.GetComponent<Image>().color, Is.EqualTo(Color.clear));
            Assert.That(audioButton.colors.selectedColor, Is.EqualTo(audioButton.colors.normalColor));

            Type controllerType = RequireType("MainMenuController, Assembly-CSharp");
            Component controller = UnityEngine.Object.FindFirstObjectByType(controllerType) as Component;
            Assert.That(controller, Is.Not.Null);
            FieldInfo iconField = controllerType.GetField(
                "audioButtonIcon",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(iconField, Is.Not.Null);
            Assert.That(iconField.GetValue(controller), Is.SameAs(icon));

            Type audioSettingsType = RequireType("GameAudioSettings, Assembly-CSharp");
            PropertyInfo isEnabledProperty = audioSettingsType.GetProperty(
                "IsEnabled",
                BindingFlags.Public | BindingFlags.Static);
            Assert.That(isEnabledProperty, Is.Not.Null);
            MethodInfo setEnabledMethod = audioSettingsType.GetMethod(
                "SetEnabled",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(bool) },
                null);
            Assert.That(setEnabledMethod, Is.Not.Null);
            bool originalPreference = (bool)isEnabledProperty.GetValue(null);

            try
            {
                Assert.That(GetProperty<bool>(icon, "IsAudioEnabled"), Is.EqualTo(originalPreference));

                audioButton.onClick.Invoke();
                yield return null;
                Assert.That((bool)isEnabledProperty.GetValue(null), Is.EqualTo(!originalPreference));
                Assert.That(GetProperty<bool>(icon, "IsAudioEnabled"), Is.EqualTo(!originalPreference));

                audioButton.onClick.Invoke();
                yield return null;
                Assert.That((bool)isEnabledProperty.GetValue(null), Is.EqualTo(originalPreference));
                Assert.That(GetProperty<bool>(icon, "IsAudioEnabled"), Is.EqualTo(originalPreference));
            }
            finally
            {
                setEnabledMethod.Invoke(null, new object[] { originalPreference });
            }
        }

        [UnityTest]
        public IEnumerator PauseMenuStopsResumesAndReturnsToTheMainMenu()
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene("Level1_BeeBoss");
            yield return null;

            Type countdownType = RequireType("RunCountdownController, Assembly-CSharp");
            Behaviour countdown = UnityEngine.Object.FindFirstObjectByType(countdownType) as Behaviour;
            Assert.That(countdown, Is.Not.Null);
            countdown.enabled = false;

            Type serviceType = RequireType("RunSessionService, Assembly-CSharp");
            object service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null);
            object session = serviceType.GetProperty(
                    "Session",
                    BindingFlags.Public | BindingFlags.Instance)
                ?.GetValue(service);
            Assert.That(session, Is.Not.Null);

            Type bossIdType = Type.GetType("ThreeBosses.Run.BossId, ThreeBosses.Run");
            Assert.That(bossIdType, Is.Not.Null);
            MethodInfo beginPractice = session.GetType().GetMethod("BeginPractice");
            Assert.That(beginPractice, Is.Not.Null);
            beginPractice.Invoke(session, new[] { Enum.Parse(bossIdType, "Bee") });
            Time.timeScale = 1f;
            yield return null;

            Button[] buttons = UnityEngine.Object.FindObjectsByType<Button>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None);
            Button pauseButton = buttons.Single(button => button.gameObject.name == "Pause Button");
            Button resumeButton = buttons.Single(button => button.gameObject.name == "Resume Button");
            Button mainMenuButton = buttons.Single(button => button.gameObject.name == "Main Menu Button");
            CanvasGroup pauseMenu = GameObject.Find("Pause Menu")?.GetComponent<CanvasGroup>();
            PlayerInput playerInput = UnityEngine.Object.FindFirstObjectByType<PlayerInput>();

            Assert.That(pauseButton.gameObject.activeSelf, Is.True);
            Assert.That(pauseMenu, Is.Not.Null);
            Assert.That(playerInput, Is.Not.Null);
            Assert.That(playerInput.enabled, Is.True);
            Assert.That(pauseMenu.alpha, Is.EqualTo(0f));

            pauseButton.onClick.Invoke();
            yield return null;
            Assert.That(Time.timeScale, Is.EqualTo(0f));
            Assert.That(GetProperty<bool>(service, "IsPausedByUser"), Is.True);
            Assert.That(pauseMenu.alpha, Is.EqualTo(1f));
            Assert.That(pauseMenu.interactable, Is.True);
            Assert.That(pauseMenu.blocksRaycasts, Is.True);
            Assert.That(playerInput.enabled, Is.False);

            resumeButton.onClick.Invoke();
            yield return null;
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(GetProperty<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(pauseMenu.alpha, Is.EqualTo(0f));
            Assert.That(playerInput.enabled, Is.True);

            playerInput.enabled = false;
            pauseButton.onClick.Invoke();
            yield return null;
            resumeButton.onClick.Invoke();
            yield return null;
            Assert.That(
                playerInput.enabled,
                Is.False,
                "Resume must not enable PlayerInput when it was already disabled before pausing.");
            playerInput.enabled = true;

            pauseButton.onClick.Invoke();
            yield return null;
            mainMenuButton.onClick.Invoke();
            yield return null;

            Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("MainMenu"));
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(GetProperty<bool>(service, "IsPausedByUser"), Is.False);
        }

        [UnityTest]
        public IEnumerator CountdownGatesGameplayBeforeTheBossCanAdvance()
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene("Level1_BeeBoss");
            yield return null;

            Type countdownType = RequireType("RunCountdownController, Assembly-CSharp");
            DefaultExecutionOrder executionOrder = countdownType
                .GetCustomAttribute<DefaultExecutionOrder>();
            Assert.That(executionOrder, Is.Not.Null);
            Assert.That(executionOrder.order, Is.LessThan(0));

            GameObject overlay = GameObject.Find("Phase12_CountdownOverlay");
            Assert.That(overlay, Is.Not.Null);
            Assert.That(overlay.GetComponent<CanvasGroup>().alpha, Is.GreaterThan(0.99f));
            Assert.That(Time.timeScale, Is.EqualTo(0f));

            Type screenFadeType = RequireType("ScreenFade, Assembly-CSharp");
            Component screenFade = UnityEngine.Object.FindFirstObjectByType(screenFadeType) as Component;
            Assert.That(screenFade, Is.Not.Null);
            Assert.That(
                overlay.transform.GetSiblingIndex(),
                Is.GreaterThan(screenFade.transform.GetSiblingIndex()));

            Behaviour countdown = UnityEngine.Object.FindFirstObjectByType(countdownType) as Behaviour;
            Assert.That(countdown, Is.Not.Null);
            Assert.That(countdown.enabled, Is.True);

            Type playerInputType = RequireType("UnityEngine.InputSystem.PlayerInput, Unity.InputSystem");
            Behaviour playerInput = UnityEngine.Object.FindFirstObjectByType(playerInputType) as Behaviour;
            Assert.That(playerInput, Is.Not.Null);
            Assert.That(playerInput.enabled, Is.False);

            Type playerWeaponType = RequireType("PlayerWeaponController, Assembly-CSharp");
            Behaviour playerWeapon = UnityEngine.Object.FindFirstObjectByType(playerWeaponType) as Behaviour;
            Assert.That(playerWeapon, Is.Not.Null);
            Assert.That(playerWeapon.enabled, Is.False);

            Type bossType = RequireType("BossController, Assembly-CSharp");
            Behaviour boss = UnityEngine.Object.FindFirstObjectByType(bossType) as Behaviour;
            Assert.That(boss, Is.Not.Null);
            FieldInfo bossControllerField = countdownType.GetField(
                "bossController",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(bossControllerField, Is.Not.Null);
            Assert.That(bossControllerField.GetValue(countdown), Is.SameAs(boss));
            Assert.That(boss.enabled, Is.False);
            Vector3 initialBossPosition = boss.transform.position;

            Animator bossAnimator = boss.GetComponentInChildren<Animator>();
            Assert.That(bossAnimator, Is.Not.Null);
            Assert.That(bossAnimator.updateMode, Is.EqualTo(AnimatorUpdateMode.Normal));

            Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            Component countdownLabel = overlay.GetComponentsInChildren(textType, true)
                .First(component => component.gameObject.name == "Countdown Text");
            for (int frame = 0;
                 frame < 3 && GetProperty<float>(countdownLabel, "alpha") <= 0f;
                 frame++)
            {
                yield return null;
            }

            Assert.That(GetProperty<string>(countdownLabel, "text"), Is.EqualTo("3"));
            Assert.That(GetProperty<float>(countdownLabel, "alpha"), Is.GreaterThan(0f));

            float readableThreeDeadline = Time.realtimeSinceStartup + 0.15f;
            while (Time.realtimeSinceStartup < readableThreeDeadline)
            {
                Assert.That(GetProperty<string>(countdownLabel, "text"), Is.EqualTo("3"));
                Assert.That(
                    GetProperty<float>(countdownLabel, "alpha"),
                    Is.GreaterThanOrEqualTo(0.99f));
                yield return null;
            }

            float entryFadeDeadline = Time.realtimeSinceStartup + 0.75f;
            while (Time.realtimeSinceStartup < entryFadeDeadline)
            {
                Assert.That(Time.timeScale, Is.EqualTo(0f));
                Assert.That(boss.transform.position, Is.EqualTo(initialBossPosition));
                yield return null;
            }

            Assert.That(Time.timeScale, Is.EqualTo(0f));
            Assert.That(boss.transform.position, Is.EqualTo(initialBossPosition));
        }

        [UnityTest]
        public IEnumerator CountdownKeepsTimerAtZeroUntilVisibleGo()
        {
            SceneManager.LoadScene("Level1_BeeBoss");
            yield return null;

            GameObject overlay = GameObject.Find("Phase12_CountdownOverlay");
            GameObject timer = GameObject.Find("Phase12_RunTimer");
            Assert.That(overlay, Is.Not.Null);
            Assert.That(timer, Is.Not.Null);

            CanvasGroup overlayCanvasGroup = overlay.GetComponent<CanvasGroup>();
            Assert.That(overlayCanvasGroup, Is.Not.Null);

            Type textType = RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro");
            Component countdownLabel = overlay.GetComponentsInChildren(textType, true)
                .First(component => component.gameObject.name == "Countdown Text");
            Component timerLabel = timer.GetComponent(textType);
            Assert.That(timerLabel, Is.Not.Null);

            Type serviceType = RequireType("RunSessionService, Assembly-CSharp");
            object service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null);
            object session = serviceType.GetProperty(
                    "Session",
                    BindingFlags.Public | BindingFlags.Instance)
                ?.GetValue(service);
            Assert.That(session, Is.Not.Null);

            bool sawVisibleGo = false;
            float deadline = Time.realtimeSinceStartup + 6f;

            while (Time.realtimeSinceStartup < deadline)
            {
                string countdownValue = GetProperty<string>(countdownLabel, "text");
                float countdownAlpha = GetProperty<float>(countdownLabel, "alpha");

                if (countdownValue == "GO!" && countdownAlpha >= 0.17f)
                {
                    sawVisibleGo = true;
                    Assert.That(overlayCanvasGroup.alpha, Is.GreaterThan(0.99f));
                    Assert.That(
                        GetProperty<object>(session, "Phase").ToString(),
                        Is.EqualTo("Running"));
                    Assert.That(Time.timeScale, Is.EqualTo(1f));
                    Type bossType = RequireType("BossController, Assembly-CSharp");
                    Behaviour boss = UnityEngine.Object.FindFirstObjectByType(bossType) as Behaviour;
                    Assert.That(boss, Is.Not.Null);
                    Assert.That(boss.enabled, Is.True);
                    break;
                }

                Assert.That(GetProperty<string>(timerLabel, "text"), Is.EqualTo("00:00.000"));
                yield return null;
            }

            Assert.That(sawVisibleGo, Is.True, "Countdown never reached a visibly rendered GO state.");

            float timerDeadline = Time.realtimeSinceStartup + 0.5f;
            while (GetProperty<string>(timerLabel, "text") == "00:00.000" &&
                   Time.realtimeSinceStartup < timerDeadline)
            {
                yield return null;
            }

            Assert.That(GetProperty<string>(timerLabel, "text"), Is.Not.EqualTo("00:00.000"));
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            Time.timeScale = 1f;
            DisarmActiveCountdownRestore();
            SceneManager.LoadScene("MainMenu");
            yield return null;

            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            MonoBehaviour service = serviceType == null
                ? null
                : UnityEngine.Object.FindFirstObjectByType(serviceType) as MonoBehaviour;
            if (service != null)
                UnityEngine.Object.Destroy(service.gameObject);
        }

        private static Type RequireType(string qualifiedName)
        {
            Type type = Type.GetType(qualifiedName);
            Assert.That(type, Is.Not.Null, $"Type {qualifiedName} was not found.");
            return type;
        }

        private static void DisarmActiveCountdownRestore()
        {
            Type countdownType = Type.GetType("RunCountdownController, Assembly-CSharp");
            FieldInfo ownsGameplayGate = countdownType?.GetField(
                "ownsGameplayGate",
                BindingFlags.Instance | BindingFlags.NonPublic);
            if (countdownType == null || ownsGameplayGate == null)
                return;

            foreach (GameObject root in SceneManager.GetActiveScene().GetRootGameObjects())
            {
                foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
                {
                    if (behaviour != null && behaviour.GetType() == countdownType)
                        ownsGameplayGate.SetValue(behaviour, false);
                }
            }
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

        private static void AssertColorApproximately(Color actual, Color expected)
        {
            Assert.That(actual.r, Is.EqualTo(expected.r).Within(0.01f));
            Assert.That(actual.g, Is.EqualTo(expected.g).Within(0.01f));
            Assert.That(actual.b, Is.EqualTo(expected.b).Within(0.01f));
            Assert.That(actual.a, Is.EqualTo(expected.a).Within(0.01f));
        }
    }
}
