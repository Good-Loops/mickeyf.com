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
            Assert.That(
                pauseButton.GetComponent<RectTransform>().sizeDelta,
                Is.EqualTo(new Vector2(48f, 48f)));
            MaskableGraphic pauseVisual = AssertPauseGlassVisual(
                pauseButton.transform,
                "PauseButton",
                new Vector2(3f, 3f));
            AssertGlassButtonHitArea(pauseButton, pauseVisual);
            Assert.That(
                pauseButton.transform.Find("Label")?.GetComponent("TextMeshProUGUI"),
                Is.Not.Null);
            Component pauseLabel = pauseButton.transform.Find("Label")
                ?.GetComponent("TextMeshProUGUI");
            Assert.That(
                pauseLabel?.GetType().GetProperty("text")?.GetValue(pauseLabel),
                Is.EqualTo(string.Empty));
            Assert.That(pauseMenu, Is.Not.Null);
            Image dimmer = pauseMenu.transform.Find("Dimmer")?.GetComponent<Image>();
            Assert.That(dimmer, Is.Not.Null);
            Assert.That(dimmer.color.a, Is.EqualTo(0.34f).Within(0.01f));

            Image panel = pauseMenu.transform.Find("Glass Panel")?.GetComponent<Image>();
            Assert.That(panel, Is.Not.Null);
            Assert.That(panel.rectTransform.sizeDelta, Is.EqualTo(new Vector2(360f, 238f)));
            Assert.That(panel.color.a, Is.Zero);
            Assert.That(panel.GetComponent<Outline>(), Is.Null);
            AssertPauseGlassVisual(panel.transform, "MenuPanel");

            Assert.That(
                resumeButton.GetComponent<RectTransform>().sizeDelta,
                Is.EqualTo(new Vector2(240f, 50f)));
            MaskableGraphic resumeVisual = AssertPauseGlassVisual(
                resumeButton.transform,
                "ActionButton",
                new Vector2(10f, 3f));
            AssertGlassButtonHitArea(resumeButton, resumeVisual);
            Component resumeLabel = resumeButton.transform.Find("Label")
                ?.GetComponent("TextMeshProUGUI");
            Assert.That(resumeLabel, Is.Not.Null);
            Assert.That(
                GetProperty<string>(resumeLabel, "text"),
                Is.EqualTo("RESUME"));

            Assert.That(
                mainMenuButton.GetComponent<RectTransform>().sizeDelta,
                Is.EqualTo(new Vector2(240f, 50f)));
            MaskableGraphic mainMenuVisual = AssertPauseGlassVisual(
                mainMenuButton.transform,
                "ActionButton",
                new Vector2(10f, 3f));
            AssertGlassButtonHitArea(mainMenuButton, mainMenuVisual);
            Component mainMenuLabel = mainMenuButton.transform.Find("Label")
                ?.GetComponent("TextMeshProUGUI");
            Assert.That(mainMenuLabel, Is.Not.Null);
            Assert.That(
                GetProperty<string>(mainMenuLabel, "text"),
                Is.EqualTo("MAIN MENU"));

            Type pauseGlassType = RequireType("PauseGlassGraphic, Assembly-CSharp");
            Graphic[] pauseGlassVisuals = pauseButton.transform.parent
                .GetComponentsInChildren(pauseGlassType, true)
                .Cast<Graphic>()
                .ToArray();
            Assert.That(pauseGlassVisuals, Has.Length.EqualTo(4));
            Assert.That(
                pauseGlassVisuals.All(graphic => !graphic.raycastTarget),
                Is.True,
                "Decorative pause glass must not intercept pointer input.");
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
            Assert.That(
                EventSystem.current?.currentSelectedGameObject,
                Is.SameAs(resumeButton.gameObject));

            resumeButton.onClick.Invoke();
            yield return null;
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(GetProperty<bool>(service, "IsPausedByUser"), Is.False);
            Assert.That(pauseMenu.alpha, Is.EqualTo(0f));
            Assert.That(playerInput.enabled, Is.True);
            Assert.That(
                EventSystem.current?.currentSelectedGameObject,
                Is.Null,
                "Gameplay must not retain a selectable UI target because Enter is bound to Fire.");

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
        public IEnumerator PauseGlassPresentationIsConsistentAcrossBattleScenes()
        {
            string[] battleScenes =
            {
                "Level1_BeeBoss",
                "Level2_CyborgBoss",
                "Level3_Kraken",
            };

            Type pauseGlassType = RequireType("PauseGlassGraphic, Assembly-CSharp");

            foreach (string sceneName in battleScenes)
            {
                Time.timeScale = 1f;
                DisarmActiveCountdownRestore();
                SceneManager.LoadScene(sceneName);
                yield return null;

                Button[] buttons = UnityEngine.Object.FindObjectsByType<Button>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None);
                Button pauseButton = buttons.Single(
                    button => button.gameObject.name == "Pause Button");
                Button resumeButton = buttons.Single(
                    button => button.gameObject.name == "Resume Button");
                Button mainMenuButton = buttons.Single(
                    button => button.gameObject.name == "Main Menu Button");

                AssertGlassButtonHitArea(
                    pauseButton,
                    AssertPauseGlassVisual(
                        pauseButton.transform,
                        "PauseButton",
                        new Vector2(3f, 3f)));
                AssertGlassButtonHitArea(
                    resumeButton,
                    AssertPauseGlassVisual(
                        resumeButton.transform,
                        "ActionButton",
                        new Vector2(10f, 3f)));
                AssertGlassButtonHitArea(
                    mainMenuButton,
                    AssertPauseGlassVisual(
                        mainMenuButton.transform,
                        "ActionButton",
                        new Vector2(10f, 3f)));

                Transform panel = GameObject.Find("Pause Menu")
                    ?.transform.Find("Glass Panel");
                Assert.That(panel, Is.Not.Null, $"{sceneName} is missing its glass panel.");
                AssertPauseGlassVisual(panel, "MenuPanel");

                Component[] visuals = pauseButton.transform.parent
                    .GetComponentsInChildren(pauseGlassType, true);
                Assert.That(
                    visuals,
                    Has.Length.EqualTo(4),
                    $"{sceneName} must contain exactly four pause glass visuals.");
            }
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

        [UnityTest]
        public IEnumerator MissingRunTicketActionStartsANewRun()
        {
            Type serviceType = RequireType("RunSessionService, Assembly-CSharp");
            object service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null);
            object session = GetProperty<object>(service, "Session");

            RequireMethod(session.GetType(), "BeginNewRun").Invoke(session, null);
            Assert.That((bool)RequireMethod(session.GetType(), "StartRun").Invoke(session, null), Is.True);
            yield return new WaitForSecondsRealtime(0.02f);

            Type bossIdType = RequireType("ThreeBosses.Run.BossId, ThreeBosses.Run");
            MethodInfo recordBossDefeat = RequireMethod(session.GetType(), "RecordBossDefeat");
            MethodInfo enterNextBoss = RequireMethod(session.GetType(), "EnterNextBoss");
            object bee = Enum.Parse(bossIdType, "Bee");
            object cyborg = Enum.Parse(bossIdType, "Cyborg");
            object kraken = Enum.Parse(bossIdType, "Kraken");

            recordBossDefeat.Invoke(session, new[] { bee });
            enterNextBoss.Invoke(session, new[] { cyborg });
            yield return new WaitForSecondsRealtime(0.02f);
            recordBossDefeat.Invoke(session, new[] { cyborg });
            enterNextBoss.Invoke(session, new[] { kraken });
            yield return new WaitForSecondsRealtime(0.02f);
            recordBossDefeat.Invoke(session, new[] { kraken });

            FieldInfo finalElapsedSecondsField = session.GetType().GetField(
                "finalElapsedSeconds",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(finalElapsedSecondsField, Is.Not.Null);
            finalElapsedSecondsField.SetValue(session, 82d);
            double elapsedSeconds = GetProperty<double>(session, "ElapsedSeconds");
            Type scoreCalculatorType = RequireType(
                "ThreeBosses.Run.RunScoreCalculator, ThreeBosses.Run");
            Type rankCalculatorType = RequireType(
                "ThreeBosses.Run.RunRankCalculator, ThreeBosses.Run");
            int score = (int)RequireMethod(scoreCalculatorType, "Calculate")
                .Invoke(null, new object[] { elapsedSeconds });
            string rank = (string)RequireMethod(rankCalculatorType, "Calculate")
                .Invoke(null, new object[] { elapsedSeconds });
            Assert.That(
                (bool)RequireMethod(session.GetType(), "TrySetResult")
                    .Invoke(session, new object[] { score, rank }),
                Is.True);

            RequireMethod(serviceType, "ConfigureRunSubmission").Invoke(service, new object[] { "1" });
            FieldInfo coordinatorField = serviceType.GetField(
                "submissionCoordinator",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(coordinatorField, Is.Not.Null);
            object coordinator = coordinatorField.GetValue(service);
            object[] beginArguments = { null };
            Assert.That(
                (bool)RequireMethod(coordinator.GetType(), "TryBegin")
                    .Invoke(coordinator, beginArguments),
                Is.True);
            object submissionPayload = beginArguments[0];
            string runId = GetProperty<string>(submissionPayload, "RunId");
            RequireMethod(coordinator.GetType(), "CompleteFailure").Invoke(
                coordinator,
                new object[] { runId, "RUN_TICKET_UNAVAILABLE" });

            SceneManager.LoadScene("End");
            yield return null;

            Button startNewRunButton = UnityEngine.Object.FindObjectsByType<Button>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None)
                .Single(button => button.gameObject.name == "Submit Score Button");
            Assert.That(startNewRunButton.interactable, Is.True);
            Component startNewRunLabel = startNewRunButton.GetComponentInChildren(
                RequireType("TMPro.TextMeshProUGUI, Unity.TextMeshPro"));
            Assert.That(
                GetProperty<string>(startNewRunLabel, "text"),
                Is.EqualTo("START A NEW RUN"));

            startNewRunButton.onClick.Invoke();
            yield return null;

            Assert.That(GetProperty<object>(session, "Phase").ToString(), Is.EqualTo("Countdown"));

            yield return new WaitForSecondsRealtime(0.4f);
            Assert.That(SceneManager.GetActiveScene().name, Is.EqualTo("Level1_BeeBoss"));
        }

        [UnityTest]
        public IEnumerator BattleScenesStartGroundedWithoutPlayingLandingDust()
        {
            string[] battleScenes =
            {
                "Level1_BeeBoss",
                "Level2_CyborgBoss",
                "Level3_Kraken",
            };

            Type motorType = RequireType("PlayerMotor, Assembly-CSharp");

            foreach (string sceneName in battleScenes)
            {
                Time.timeScale = 1f;
                DisarmActiveCountdownRestore();
                SceneManager.LoadScene(sceneName);
                yield return null;

                Component motor = UnityEngine.Object.FindFirstObjectByType(
                    motorType,
                    FindObjectsInactive.Include) as Component;
                Assert.That(motor, Is.Not.Null, $"{sceneName} is missing PlayerMotor.");
                Assert.That(
                    GetProperty<bool>(motor, "IsGrounded"),
                    Is.True,
                    $"{sceneName} must start with the player grounded.");

                CapsuleCollider2D playerCollider = motor.GetComponent<CapsuleCollider2D>();
                CompositeCollider2D floorCollider = SceneManager.GetActiveScene()
                    .GetRootGameObjects()
                    .SelectMany(root => root.GetComponentsInChildren<CompositeCollider2D>(true))
                    .Single(collider => collider.gameObject.layer == 3);
                ColliderDistance2D floorDistance = playerCollider.Distance(floorCollider);
                Assert.That(floorDistance.isValid, Is.True);
                Assert.That(
                    Mathf.Abs(floorDistance.distance),
                    Is.LessThanOrEqualTo(0.01f),
                    $"{sceneName} player must begin in physical contact with the floor.");
                Assert.That(CountLandingDustClones(), Is.Zero);
            }
        }

        [UnityTest]
        public IEnumerator LandingAfterStartupStillPlaysDustOnce()
        {
            Time.timeScale = 1f;
            SceneManager.LoadScene("Level1_BeeBoss");
            yield return null;

            Type motorType = RequireType("PlayerMotor, Assembly-CSharp");
            Component motor = UnityEngine.Object.FindFirstObjectByType(
                motorType,
                FindObjectsInactive.Include) as Component;
            Assert.That(motor, Is.Not.Null);
            Assert.That(CountLandingDustClones(), Is.Zero);

            Vector3 groundedPosition = motor.transform.position;
            motor.transform.position = groundedPosition + Vector3.up;
            Physics2D.SyncTransforms();
            yield return null;
            Assert.That(GetProperty<bool>(motor, "IsGrounded"), Is.False);

            motor.transform.position = groundedPosition;
            Physics2D.SyncTransforms();
            yield return null;

            Assert.That(GetProperty<bool>(motor, "IsGrounded"), Is.True);
            Assert.That(CountLandingDustClones(), Is.EqualTo(1));
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

        private static int CountLandingDustClones()
        {
            return UnityEngine.Object.FindObjectsByType<ParticleSystem>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None)
                .Count(particleSystem => particleSystem.name == "VFX_LandDust(Clone)");
        }

        private static T GetProperty<T>(object target, string name)
        {
            PropertyInfo property = target.GetType().GetProperty(
                name,
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(property, Is.Not.Null, $"Property {target.GetType().FullName}.{name} was not found.");
            return (T)property.GetValue(target);
        }

        private static MaskableGraphic AssertPauseGlassVisual(
            Transform owner,
            string expectedStyle,
            Vector2 expectedInset = default)
        {
            Type graphicType = RequireType("PauseGlassGraphic, Assembly-CSharp");
            Transform visual = owner.Find("Visual");
            Assert.That(visual, Is.Not.Null, owner.name);
            Component[] glassGraphics = visual.GetComponents(graphicType);
            Assert.That(glassGraphics, Has.Length.EqualTo(1), owner.name);

            MaskableGraphic graphic = glassGraphics[0] as MaskableGraphic;
            Assert.That(graphic, Is.Not.Null, owner.name);
            Assert.That(graphic.gameObject.name, Is.EqualTo("Visual"), owner.name);
            Assert.That(graphic.raycastTarget, Is.False, owner.name);
            Assert.That(
                GetProperty<object>(graphic, "ControlStyle").ToString(),
                Is.EqualTo(expectedStyle),
                owner.name);

            RectTransform visualRect = graphic.rectTransform;
            Assert.That(visualRect.anchorMin, Is.EqualTo(Vector2.zero), owner.name);
            Assert.That(visualRect.anchorMax, Is.EqualTo(Vector2.one), owner.name);
            Assert.That(visualRect.offsetMin, Is.EqualTo(expectedInset), owner.name);
            Assert.That(visualRect.offsetMax, Is.EqualTo(-expectedInset), owner.name);
            return graphic;
        }

        private static void AssertGlassButtonHitArea(
            Button button,
            MaskableGraphic visual)
        {
            Image hitArea = button.GetComponent<Image>();
            Assert.That(hitArea, Is.Not.Null, button.name);
            Assert.That(hitArea.color.a, Is.Zero, button.name);
            Assert.That(hitArea.raycastTarget, Is.True, button.name);
            Assert.That(button.GetComponent<Outline>(), Is.Null, button.name);
            Assert.That(button.targetGraphic, Is.SameAs(visual), button.name);
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
