using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class Boss3PhaseTwoTests
    {
        private const string LevelThreeScenePath = "Assets/Scenes/Level3_Kraken.unity";

        [UnitySetUp]
        public IEnumerator LoadLevelThree()
        {
            SceneManager.LoadScene(LevelThreeScenePath, LoadSceneMode.Single);
            yield return null;

            Assert.That(SceneManager.GetActiveScene().path, Is.EqualTo(LevelThreeScenePath));
            ResetKrakenPracticeRun();
        }

        [UnityTest]
        public IEnumerator PhaseTwoActivatesAtHalfHealthAndStaysLatched()
        {
            Boss3Fixture fixture = Boss3Fixture.Find();
            int halfHealth = fixture.MaxHealth / 2;

            fixture.SetHealth(halfHealth + 1);
            Assert.That(fixture.IsInPhaseTwo, Is.False);

            fixture.SetHealth(halfHealth);
            Assert.That(fixture.IsInPhaseTwo, Is.True);

            fixture.SetHealth(fixture.MaxHealth);
            fixture.SetHealth(halfHealth - 1);
            Assert.That(fixture.IsInPhaseTwo, Is.True);

            yield return null;
        }

        [UnityTest]
        public IEnumerator PhaseTwoLatchesAcrossDamageAndHealingInTheSameFrame()
        {
            Boss3Fixture fixture = Boss3Fixture.Find();

            fixture.SetHealth(fixture.MaxHealth / 2 - 1);
            fixture.SetHealth(fixture.MaxHealth);

            Assert.That(fixture.IsInPhaseTwo, Is.True);
            yield return null;
        }

        [UnityTest]
        public IEnumerator LethalDamageKeepsPhaseTwoOffAndEntersDeath()
        {
            Boss3Fixture fixture = Boss3Fixture.Find();

            fixture.SetHealth(0);
            Assert.That(fixture.IsInPhaseTwo, Is.False);

            yield return null;
            Assert.That(fixture.IsInvulnerable, Is.True);
        }

        [UnityTest]
        public IEnumerator PhaseTwoRuneSelectionUsesThreeAnchors()
        {
            Boss3Fixture fixture = Boss3Fixture.Find();

            Assert.That(fixture.CountSelectedRuneAnchors(isPhaseTwo: false), Is.EqualTo(2));
            Assert.That(fixture.CountSelectedRuneAnchors(isPhaseTwo: true), Is.EqualTo(3));

            yield return null;
        }

        [UnityTest]
        public IEnumerator BossDefeatLockProtectsPlayerWithoutFreezingPresentation()
        {
            yield return new WaitForSecondsRealtime(1.2f);

            Boss3Fixture bossFixture = Boss3Fixture.Find();
            Type handlerType = RequireRuntimeType("PlayerDeathHandler");
            Type loaderType = RequireRuntimeType("BossDefeatSceneLoader");
            Type remainsType = RequireRuntimeType("BossRemains");
            MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None);
            MonoBehaviour handler = Array.Find(behaviours, behaviour => behaviour.GetType() == handlerType);
            MonoBehaviour loader = Array.Find(behaviours, behaviour => behaviour.GetType() == loaderType);
            Assert.That(handler, Is.Not.Null, "PlayerDeathHandler was not found in Level 3.");
            Assert.That(loader, Is.Not.Null, "BossDefeatSceneLoader was not found in Level 3.");

            FieldInfo healthField = handlerType.GetField("health", BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo rigidbodyField = handlerType.GetField("rb", BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo loaderHandlerField = loaderType.GetField(
                "playerDeathHandler",
                BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo loadDelayField = loaderType.GetField(
                "loadDelaySeconds",
                BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo fadeStartField = loaderType.GetField(
                "fadeStartDelaySeconds",
                BindingFlags.Instance | BindingFlags.NonPublic);
            FieldInfo fadeDurationField = loaderType.GetField(
                "fadeDurationSeconds",
                BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.That(healthField, Is.Not.Null);
            Assert.That(rigidbodyField, Is.Not.Null);
            Assert.That(loaderHandlerField, Is.Not.Null);
            Assert.That(loadDelayField, Is.Not.Null);
            Assert.That(fadeStartField, Is.Not.Null);
            Assert.That(fadeDurationField, Is.Not.Null);

            Component health = (Component)healthField.GetValue(handler);
            Rigidbody2D playerBody = (Rigidbody2D)rigidbodyField.GetValue(handler);
            Assert.That(health, Is.Not.Null);
            Assert.That(playerBody, Is.Not.Null);

            Type healthType = health.GetType();
            PropertyInfo currentHealth = RequireProperty(healthType, "CurrentHealth");
            PropertyInfo isInvulnerable = RequireProperty(healthType, "IsInvulnerable");
            MethodInfo tryTakeDamage = RequireMethod(
                healthType,
                "TryTakeDamage",
                BindingFlags.Instance | BindingFlags.Public);

            Assert.That(loaderHandlerField.GetValue(loader), Is.SameAs(handler));
            float fadeStartDelaySeconds = (float)fadeStartField.GetValue(loader);
            Assert.That(fadeStartDelaySeconds, Is.EqualTo(0.9f));
            Assert.That((float)fadeDurationField.GetValue(loader), Is.EqualTo(0.5f));
            Assert.That((float)loadDelayField.GetValue(loader), Is.EqualTo(1.4f));

            float timeScaleBeforeLock = Time.timeScale;
            int healthBeforeLock = (int)currentHealth.GetValue(health);
            int remainsBeforeDeath = CountBehavioursOfType(remainsType);
            float deathHandoffDeadline =
                Time.realtimeSinceStartup + fadeStartDelaySeconds;
            bossFixture.SetHealth(0);

            bool damageApplied = (bool)tryTakeDamage.Invoke(health, new object[] { 1 });
            Assert.That((bool)isInvulnerable.GetValue(health), Is.True);
            Assert.That(damageApplied, Is.False);
            Assert.That((int)currentHealth.GetValue(health), Is.EqualTo(healthBeforeLock));
            Assert.That(playerBody.simulated, Is.False);
            Assert.That(Time.timeScale, Is.EqualTo(timeScaleBeforeLock));

            while (
                bossFixture.IsDeathVisualActive
                && Time.realtimeSinceStartup < deathHandoffDeadline)
            {
                yield return null;
            }

            Assert.That(
                bossFixture.IsDeathVisualActive,
                Is.False,
                "Kraken's death animation did not hand off before the screen fade.");
            Assert.That(
                CountBehavioursOfType(remainsType),
                Is.GreaterThan(remainsBeforeDeath),
                "Kraken's final death frame should hand off to visible remains before the fade begins.");
            Assert.That(GetScreenFadeAlpha(), Is.EqualTo(0f).Within(0.001f));
        }

        private static int CountBehavioursOfType(Type type)
        {
            MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None);
            return Array.FindAll(behaviours, behaviour => behaviour.GetType() == type).Length;
        }

        private static float GetScreenFadeAlpha()
        {
            Type screenFadeType = RequireRuntimeType("ScreenFade");
            MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None);
            MonoBehaviour screenFade = Array.Find(
                behaviours,
                behaviour => behaviour.GetType() == screenFadeType);
            Assert.That(screenFade, Is.Not.Null, "ScreenFade was not found in Level 3.");

            UnityEngine.UI.Image image = screenFade.GetComponent<UnityEngine.UI.Image>();
            Assert.That(image, Is.Not.Null, "ScreenFade is missing its Image.");
            return image.color.a;
        }

        private static void ResetKrakenPracticeRun()
        {
            Type serviceType = RequireRuntimeType("RunSessionService");
            PropertyInfo instanceProperty = serviceType.GetProperty(
                "Instance",
                BindingFlags.Static | BindingFlags.Public);
            PropertyInfo sessionProperty = serviceType.GetProperty(
                "Session",
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(instanceProperty, Is.Not.Null);
            Assert.That(sessionProperty, Is.Not.Null);

            object service = instanceProperty.GetValue(null);
            object session = sessionProperty.GetValue(service);
            MethodInfo beginPractice = session.GetType().GetMethod(
                "BeginPractice",
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(beginPractice, Is.Not.Null);

            Type bossIdType = beginPractice.GetParameters()[0].ParameterType;
            object kraken = Enum.Parse(bossIdType, "Kraken");
            beginPractice.Invoke(session, new[] { kraken });
        }

        private static Type RequireRuntimeType(string typeName)
        {
            Type type = Type.GetType($"{typeName}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Runtime type {typeName} was not found.");
            return type;
        }

        private static MethodInfo RequireMethod(Type type, string name, BindingFlags bindingFlags)
        {
            MethodInfo method = type.GetMethod(name, bindingFlags);
            Assert.That(method, Is.Not.Null, $"Method {type.FullName}.{name} was not found.");
            return method;
        }

        private static PropertyInfo RequireProperty(Type type, string name)
        {
            PropertyInfo property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
            Assert.That(property, Is.Not.Null, $"Property {type.FullName}.{name} was not found.");
            return property;
        }

        private sealed class Boss3Fixture
        {
            private readonly Component boss;
            private readonly Component health;
            private readonly Component runeAttack;
            private readonly MethodInfo setHealth;
            private readonly MethodInfo selectAnchors;
            private readonly Animator animator;
            private readonly PropertyInfo maxHealth;
            private readonly PropertyInfo isInPhaseTwo;
            private readonly PropertyInfo isInvulnerable;

            private Boss3Fixture(Component boss, Component health, Component runeAttack)
            {
                this.boss = boss;
                this.health = health;
                this.runeAttack = runeAttack;
                animator = (Animator)RequireField(
                    boss.GetType(),
                    "animator").GetValue(boss);
                Assert.That(animator, Is.Not.Null, "Boss 3 Animator was not configured.");

                Type healthType = health.GetType();
                setHealth = RequireMethod(healthType, "SetHealth", BindingFlags.Instance | BindingFlags.Public);
                maxHealth = RequireProperty(healthType, "MaxHealth");

                Type bossType = boss.GetType();
                isInPhaseTwo = RequireProperty(bossType, "IsInPhaseTwo");
                isInvulnerable = RequireProperty(bossType, "IsInvulnerable");

                selectAnchors = RequireMethod(
                    runeAttack.GetType(),
                    "SelectAnchors",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            }

            public int MaxHealth => (int)maxHealth.GetValue(health);
            public bool IsInPhaseTwo => (bool)isInPhaseTwo.GetValue(boss);
            public bool IsInvulnerable => (bool)isInvulnerable.GetValue(boss);
            public bool IsDeathVisualActive => animator.gameObject.activeSelf;

            public void SetHealth(int value)
            {
                setHealth.Invoke(health, new object[] { value });
            }

            public int CountSelectedRuneAnchors(bool isPhaseTwo)
            {
                object result = selectAnchors.Invoke(runeAttack, new object[] { isPhaseTwo });
                Assert.That(result, Is.InstanceOf<ICollection>());
                return ((ICollection)result).Count;
            }

            public static Boss3Fixture Find()
            {
                Type bossType = Boss3PhaseTwoTests.RequireRuntimeType("Boss3Controller");
                Type healthType = Boss3PhaseTwoTests.RequireRuntimeType("HealthComponent");
                Type runeAttackType = Boss3PhaseTwoTests.RequireRuntimeType("Boss3RuneAttack");

                MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None);

                MonoBehaviour boss = Array.Find(behaviours, behaviour => behaviour.GetType() == bossType);
                Assert.That(boss, Is.Not.Null, "Boss3Controller was not found in Level 3.");

                Component health = boss.GetComponent(healthType);
                Component runeAttack = boss.GetComponent(runeAttackType);
                Assert.That(health, Is.Not.Null, "HealthComponent was not found on Boss 3.");
                Assert.That(runeAttack, Is.Not.Null, "Boss3RuneAttack was not found on Boss 3.");

                return new Boss3Fixture(boss, health, runeAttack);
            }

            private static MethodInfo RequireMethod(Type type, string name, BindingFlags bindingFlags)
            {
                MethodInfo method = type.GetMethod(name, bindingFlags);
                Assert.That(method, Is.Not.Null, $"Method {type.FullName}.{name} was not found.");
                return method;
            }

            private static PropertyInfo RequireProperty(Type type, string name)
            {
                PropertyInfo property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
                Assert.That(property, Is.Not.Null, $"Property {type.FullName}.{name} was not found.");
                return property;
            }

            private static FieldInfo RequireField(Type type, string name)
            {
                FieldInfo field = type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
                Assert.That(field, Is.Not.Null, $"Field {type.FullName}.{name} was not found.");
                return field;
            }
        }
    }
}
