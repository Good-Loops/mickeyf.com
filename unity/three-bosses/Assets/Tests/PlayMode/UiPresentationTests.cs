using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using UnityEngine.UIElements;

namespace ThreeBosses.Tests
{
    public sealed class UiPresentationTests
    {
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
        [Category("ScreenUI")]
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

            UIDocument document = UnityEngine.Object.FindFirstObjectByType<UIDocument>();
            Assert.That(document, Is.Not.Null);
            UnityEngine.UIElements.Button startNewRunButton = document.rootVisualElement
                .Q<UnityEngine.UIElements.Button>("submit-score-button");
            Assert.That(startNewRunButton, Is.Not.Null);
            Assert.That(startNewRunButton.enabledSelf, Is.True);
            Assert.That(startNewRunButton.text, Is.EqualTo("START A NEW RUN"));

            startNewRunButton.Focus();
            using (NavigationSubmitEvent submit = NavigationSubmitEvent.GetPooled())
                startNewRunButton.SendEvent(submit);
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

    }
}
