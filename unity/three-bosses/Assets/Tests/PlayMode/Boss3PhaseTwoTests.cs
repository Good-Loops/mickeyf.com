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

        private sealed class Boss3Fixture
        {
            private readonly Component boss;
            private readonly Component health;
            private readonly Component runeAttack;
            private readonly MethodInfo setHealth;
            private readonly MethodInfo selectAnchors;
            private readonly PropertyInfo maxHealth;
            private readonly PropertyInfo isInPhaseTwo;
            private readonly PropertyInfo isInvulnerable;

            private Boss3Fixture(Component boss, Component health, Component runeAttack)
            {
                this.boss = boss;
                this.health = health;
                this.runeAttack = runeAttack;

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
                Type bossType = RequireRuntimeType("Boss3Controller");
                Type healthType = RequireRuntimeType("HealthComponent");
                Type runeAttackType = RequireRuntimeType("Boss3RuneAttack");

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
        }
    }
}
