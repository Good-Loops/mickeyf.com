using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class ProjectileImpactTests
    {
        private Scene physicsScene;
        private GameObject projectile;

        [SetUp]
        public void SetUp()
        {
            physicsScene = SceneManager.CreateScene(
                nameof(ProjectileImpactTests),
                new CreateSceneParameters(LocalPhysicsMode.Physics2D));
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            if (physicsScene.IsValid() && physicsScene.isLoaded)
                yield return SceneManager.UnloadSceneAsync(physicsScene);
        }

        [UnityTest]
        public IEnumerator StingerDamagesPlayerOnceWhenTwoCollidersOverlap()
        {
            Component health = CreateTarget("PlayerDamageReceiver");
            Component stinger = CreateProjectile("StingerProjectile", isTrigger: true);
            Component source = projectile.GetComponent(RuntimeType("DamageSource"));
            FieldInfo faction = source.GetType().GetField("faction", BindingFlags.Instance | BindingFlags.NonPublic);
            faction.SetValue(source, Enum.Parse(faction.FieldType, "Enemy"));
            Initialize(stinger);

            physicsScene.GetPhysicsScene2D().Simulate(0.02f);

            Assert.That(CurrentHealth(health), Is.EqualTo(90),
                "One stinger must deal its 10 damage once, even with two overlapping player colliders.");
            yield return null;
            Assert.That(projectile == null, Is.True, "The stinger must be consumed by the hit.");
        }

        [UnityTest]
        public IEnumerator PhaseAnchorDamagesOnceWhenNonAnchorTargetHasTwoColliders()
        {
            Component health = CreateTarget("GenericDamageReceiver");
            Component anchor = CreateProjectile("PhaseAnchorProjectile", isTrigger: false);
            Initialize(anchor);

            physicsScene.GetPhysicsScene2D().Simulate(0.02f);

            Assert.That(CurrentHealth(health), Is.EqualTo(75),
                "An anchor that cannot attach must deal its 25 damage once before being destroyed.");
            yield return null;
            Assert.That(projectile == null, Is.True, "A non-anchoring hit must consume the projectile.");
        }

        [UnityTest]
        public IEnumerator PhaseAnchorAttachesOnceAndReplacesFlightExpiryWithAnchorExpiry()
        {
            Component health = CreateTarget("GenericDamageReceiver");
            Component anchor = CreateProjectile("PhaseAnchorProjectile", isTrigger: false);
            SetField(anchor, "anchorSurfaceMask", (LayerMask)(1 << 0));
            SetField(anchor, "maxLifeSeconds", 0.01f);
            SetField(anchor, "anchoredLifeSeconds", 0.2f);
            Initialize(anchor);

            physicsScene.GetPhysicsScene2D().Simulate(0.02f);

            Assert.That(CurrentHealth(health), Is.EqualTo(75));
            Assert.That(projectile.GetComponent<Rigidbody2D>().simulated, Is.False);
            Assert.That(projectile.GetComponent<Collider2D>().enabled, Is.False);
            yield return new WaitForSeconds(0.05f);
            Assert.That(projectile != null, Is.True, "Attaching must cancel the in-flight expiry.");
            yield return new WaitForSeconds(0.25f);
            Assert.That(projectile == null, Is.True, "The attached projectile must expire after its anchor lifetime.");
        }

        private Component CreateTarget(string receiverType)
        {
            GameObject target = CreateObject("Target");
            target.transform.position = new Vector3(0.75f, 0f, 0f);
            Component health = target.AddComponent(RuntimeType("HealthComponent"));
            target.AddComponent(RuntimeType(receiverType));
            target.AddComponent<BoxCollider2D>().offset = Vector2.up * 0.1f;
            target.AddComponent<BoxCollider2D>().offset = Vector2.down * 0.1f;
            return health;
        }

        private Component CreateProjectile(string projectileType, bool isTrigger)
        {
            projectile = CreateObject(projectileType);
            Rigidbody2D body = projectile.AddComponent<Rigidbody2D>();
            body.gravityScale = 0f;
            body.constraints = RigidbodyConstraints2D.FreezeRotation;
            projectile.AddComponent<BoxCollider2D>().isTrigger = isTrigger;
            return projectile.AddComponent(RuntimeType(projectileType));
        }

        private GameObject CreateObject(string name)
        {
            GameObject instance = new GameObject(name);
            SceneManager.MoveGameObjectToScene(instance, physicsScene);
            return instance;
        }

        private static void Initialize(Component behaviour)
        {
            behaviour.GetType().GetMethod("Init").Invoke(
                behaviour, new object[] { Vector2.right, 10f, null });
        }

        private static int CurrentHealth(Component health)
        {
            return (int)health.GetType().GetProperty("CurrentHealth").GetValue(health);
        }

        private static void SetField(Component behaviour, string name, object value)
        {
            behaviour.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
                .SetValue(behaviour, value);
        }

        private static Type RuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Runtime type {name} was not found.");
            return type;
        }
    }
}
