using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class Boss3RuneAttackTests
    {
        private Scene originalScene;
        private Scene testScene;
        private MonoBehaviour attack;

        [SetUp]
        public void SetUp()
        {
            originalScene = SceneManager.GetActiveScene();
            testScene = SceneManager.CreateScene(nameof(Boss3RuneAttackTests));
            SceneManager.SetActiveScene(testScene);

            GameObject boss = new GameObject("Boss");
            for (int x = -2; x <= 2; x += 2)
            {
                GameObject anchor = new GameObject("Anchor");
                anchor.transform.SetParent(boss.transform);
                anchor.transform.position = new Vector3(x, 0f, 0f);
                anchor.AddComponent(RuntimeType("Boss3RuneGroundAnchor"));
            }

            attack = (MonoBehaviour)boss.AddComponent(RuntimeType("Boss3RuneAttack"));
            SetField("playerTarget", new GameObject("Player").transform);
            SetField("runeWarningPrefab", new GameObject("Warning"));
            SetField("runeExplosionPrefab", new GameObject("Explosion"));
            Call("BeginAttack");
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            SceneManager.SetActiveScene(originalScene);
            yield return SceneManager.UnloadSceneAsync(testScene);
        }

        [UnityTest]
        public IEnumerator CancelledCastCannotDetonateOrRemoveTheNextCastsWarnings()
        {
            IEnumerator cancelledCast = StartCast(isPhaseTwo: true);
            Call("CancelAttack");
            Call("BeginAttack");
            IEnumerator currentCast = StartCast(isPhaseTwo: false);
            yield return null;

            Assert.That(cancelledCast.MoveNext(), Is.False,
                "Starting another attack must not revive a cancelled cast.");
            yield return null;
            Assert.That(CountClones("Warning"), Is.EqualTo(2));
            Assert.That(CountClones("Explosion"), Is.Zero);

            Assert.That(currentCast.MoveNext(), Is.True);
            yield return null;
            Assert.That(CountClones("Warning"), Is.Zero);
            Assert.That(CountClones("Explosion"), Is.EqualTo(2),
                "The current cast must still detonate at its two selected anchors.");
        }

        [UnityTest]
        public IEnumerator RepeatedCastReplacesWarningsWithoutLeavingAnOlderDetonation()
        {
            IEnumerator previousCast = StartCast(isPhaseTwo: false);
            IEnumerator currentCast = StartCast(isPhaseTwo: true);
            yield return null;

            Assert.That(CountClones("Warning"), Is.EqualTo(3),
                "Replacing a cast must remove the previous cast's warning objects.");
            Assert.That(previousCast.MoveNext(), Is.False);
            Assert.That(currentCast.MoveNext(), Is.True);
            yield return null;
            Assert.That(CountClones("Warning"), Is.Zero);
            Assert.That(CountClones("Explosion"), Is.EqualTo(3));
        }

        [UnityTest]
        public IEnumerator DisablingRuneAttackCancelsAnExternallyOwnedCoroutine()
        {
            IEnumerator cast = StartCast(isPhaseTwo: true);
            attack.enabled = false;
            yield return null;

            Assert.That(cast.MoveNext(), Is.False,
                "The controller owns the coroutine; disabling this component must invalidate it explicitly.");
            yield return null;
            Assert.That(CountClones("Warning"), Is.Zero);
            Assert.That(CountClones("Explosion"), Is.Zero);
        }

        private IEnumerator StartCast(bool isPhaseTwo)
        {
            IEnumerator cast = (IEnumerator)attack.GetType().GetMethod("Execute")
                .Invoke(attack, new object[] { isPhaseTwo });
            // Advance to the warning wait; resume explicitly to test cancellation
            // ordering without depending on frame timing or the authored duration.
            Assert.That(cast.MoveNext(), Is.True);
            Assert.That(cast.Current, Is.TypeOf<WaitForSeconds>());
            return cast;
        }

        private int CountClones(string templateName)
        {
            return Array.FindAll(testScene.GetRootGameObjects(),
                obj => obj.name == templateName + "(Clone)").Length;
        }

        private void Call(string methodName)
        {
            attack.GetType().GetMethod(methodName).Invoke(attack, null);
        }

        private void SetField(string name, object value)
        {
            attack.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
                .SetValue(attack, value);
        }

        private static Type RuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Runtime type {name} was not found.");
            return type;
        }
    }
}
