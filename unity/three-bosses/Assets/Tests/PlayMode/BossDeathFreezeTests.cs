using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class BossDeathFreezeTests
    {
        private const string LevelOneScenePath = "Assets/Scenes/Level1_BeeBoss.unity";
        private const string LevelTwoScenePath = "Assets/Scenes/Level2_CyborgBoss.unity";
        private const float ActiveFreezeSeconds = 10f;

        private float originalTimeScale;
        private Scene loadedScene;

        [SetUp]
        public void SetUp()
        {
            originalTimeScale = Time.timeScale;
            Time.timeScale = 1f;
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            Time.timeScale = 1f;

            if (loadedScene.IsValid() && loadedScene.isLoaded)
            {
                Scene cleanupScene = SceneManager.CreateScene($"{nameof(BossDeathFreezeTests)} Cleanup");
                if (SceneManager.GetActiveScene() == loadedScene)
                    SceneManager.SetActiveScene(cleanupScene);

                AsyncOperation unloadOperation = SceneManager.UnloadSceneAsync(loadedScene);
                if (unloadOperation != null)
                    yield return unloadOperation;
            }

            DestroyRunSessionService();
            yield return null;

            Time.timeScale = originalTimeScale;
        }

        [UnityTest]
        public IEnumerator BeeKilledDuringFreezeRestoresDeathAnimationSpeed()
        {
            yield return LoadBossScene(LevelOneScenePath, "Bee");

            BossFixture fixture = BossFixture.Find("BossController", "Bee");
            Color baseColor = fixture.Visual.color;

            fixture.ApplyFreeze(ActiveFreezeSeconds);
            yield return null;

            Assert.That(fixture.Animator.speed, Is.EqualTo(0f), "The living Bee Animator should pause while frozen.");
            Assert.That(fixture.FreezeUntil, Is.GreaterThan(Time.time));

            fixture.Kill();

            Assert.That(fixture.FreezeUntil, Is.EqualTo(-1f), "Bee death should clear the active freeze timer.");
            Assert.That(fixture.Animator.speed, Is.EqualTo(1f), "Bee death should immediately restore normal Animator speed.");
            Assert.That(fixture.Visual.color, Is.EqualTo(baseColor), "Bee death should restore its base color.");

            yield return null;

            Assert.That(fixture.Animator.speed, Is.EqualTo(1f), "Bee death playback should remain unpaused.");
            Assert.That(fixture.Visual.color, Is.EqualTo(baseColor));
        }

        [UnityTest]
        public IEnumerator CyborgKilledDuringFreezeKeepsDeathAnimationRunning()
        {
            yield return LoadBossScene(LevelTwoScenePath, "Cyborg");

            BossFixture fixture = BossFixture.Find("Boss2Controller", "Cyborg");
            Component deathController = fixture.Boss.GetComponent(RequireRuntimeType("Boss2DeathController"));
            PropertyInfo isDead = RequireProperty(deathController.GetType(), "IsDead");
            Color baseColor = fixture.Visual.color;

            fixture.ApplyFreeze(ActiveFreezeSeconds);
            yield return null;

            Assert.That(fixture.Animator.speed, Is.EqualTo(0f), "The living Cyborg Animator should pause while frozen.");
            Assert.That(fixture.FreezeUntil, Is.GreaterThan(Time.time));

            fixture.Kill();

            Assert.That((bool)isDead.GetValue(deathController), Is.True);
            Assert.That(fixture.FreezeUntil, Is.GreaterThan(Time.time), "The regression must be covered while freeze is still active.");
            Assert.That(fixture.Animator.speed, Is.EqualTo(1f), "Cyborg death should immediately restore normal Animator speed.");
            Assert.That(fixture.Visual.color, Is.EqualTo(baseColor), "Cyborg death should restore its base color.");

            yield return null;

            Assert.That(fixture.Animator.speed, Is.EqualTo(1f), "Boss2Controller should not pause death playback again.");
            Assert.That(fixture.Visual.color, Is.EqualTo(baseColor));

            yield return null;

            Assert.That(fixture.Animator.speed, Is.EqualTo(1f), "Cyborg death playback should remain unpaused.");
        }

        private IEnumerator LoadBossScene(string scenePath, string bossId)
        {
            BeginPracticeRun(bossId);
            SceneManager.LoadScene(scenePath, LoadSceneMode.Single);
            yield return null;

            loadedScene = SceneManager.GetActiveScene();
            Time.timeScale = 1f;

            Assert.That(loadedScene.path, Is.EqualTo(scenePath));
        }

        private static void BeginPracticeRun(string bossId)
        {
            Type serviceType = RequireRuntimeType("RunSessionService");
            PropertyInfo instanceProperty = RequireProperty(serviceType, "Instance", BindingFlags.Static | BindingFlags.Public);
            PropertyInfo sessionProperty = RequireProperty(serviceType, "Session");

            object service = instanceProperty.GetValue(null);
            object session = sessionProperty.GetValue(service);
            MethodInfo beginPractice = RequireMethod(
                session.GetType(),
                "BeginPractice",
                BindingFlags.Instance | BindingFlags.Public);
            Type bossIdType = beginPractice.GetParameters()[0].ParameterType;

            beginPractice.Invoke(session, new[] { Enum.Parse(bossIdType, bossId) });
        }

        private static void DestroyRunSessionService()
        {
            Type serviceType = Type.GetType("RunSessionService, Assembly-CSharp");
            if (serviceType == null)
                return;

            MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None);

            foreach (MonoBehaviour behaviour in behaviours)
            {
                if (behaviour.GetType() == serviceType)
                    UnityEngine.Object.Destroy(behaviour.gameObject);
            }
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

        private static PropertyInfo RequireProperty(
            Type type,
            string name,
            BindingFlags bindingFlags = BindingFlags.Instance | BindingFlags.Public)
        {
            PropertyInfo property = type.GetProperty(name, bindingFlags);
            Assert.That(property, Is.Not.Null, $"Property {type.FullName}.{name} was not found.");
            return property;
        }

        private sealed class BossFixture
        {
            private readonly Component health;
            private readonly MethodInfo applyFreeze;
            private readonly MethodInfo setHealth;
            private readonly FieldInfo freezeUntil;

            private BossFixture(Component boss, Component health, Animator animator, SpriteRenderer visual)
            {
                Boss = boss;
                this.health = health;
                Animator = animator;
                Visual = visual;

                Type bossType = boss.GetType();
                applyFreeze = RequireMethod(bossType, "ApplyFreeze", BindingFlags.Instance | BindingFlags.Public);
                freezeUntil = RequireField(bossType, "freezeUntil");
                setHealth = RequireMethod(
                    health.GetType(),
                    "SetHealth",
                    BindingFlags.Instance | BindingFlags.Public);
            }

            public Component Boss { get; }
            public Animator Animator { get; }
            public SpriteRenderer Visual { get; }
            public float FreezeUntil => (float)freezeUntil.GetValue(Boss);

            public void ApplyFreeze(float seconds)
            {
                applyFreeze.Invoke(Boss, new object[] { seconds });
            }

            public void Kill()
            {
                setHealth.Invoke(health, new object[] { 0 });
            }

            public static BossFixture Find(string controllerTypeName, string bossName)
            {
                Type bossType = RequireRuntimeType(controllerTypeName);
                Type healthType = RequireRuntimeType("HealthComponent");
                MonoBehaviour[] behaviours = UnityEngine.Object.FindObjectsByType<MonoBehaviour>(
                    FindObjectsInactive.Include,
                    FindObjectsSortMode.None);
                MonoBehaviour boss = Array.Find(behaviours, behaviour => behaviour.GetType() == bossType);

                Assert.That(boss, Is.Not.Null, $"{controllerTypeName} was not found in the {bossName} scene.");

                Component health = boss.GetComponent(healthType);
                Animator animator = RequireField(bossType, "animator").GetValue(boss) as Animator;
                SpriteRenderer visual = RequireField(bossType, "visualRenderer").GetValue(boss) as SpriteRenderer;

                Assert.That(health, Is.Not.Null, $"HealthComponent was not found on the {bossName}.");
                Assert.That(animator, Is.Not.Null, $"Animator was not configured on the {bossName}.");
                Assert.That(visual, Is.Not.Null, $"SpriteRenderer was not configured on the {bossName}.");

                return new BossFixture(boss, health, animator, visual);
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
