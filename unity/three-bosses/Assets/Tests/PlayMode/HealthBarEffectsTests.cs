using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UI;

namespace ThreeBosses.Tests
{
    public sealed class HealthBarEffectsTests
    {
        private GameObject healthBar;
        private Image fill;
        private MonoBehaviour flash;
        private MonoBehaviour pulse;
        private readonly Color baseColor = new Color(0.1f, 0.8f, 0.2f, 0.8f);

        [SetUp]
        public void SetUp()
        {
            healthBar = new GameObject("Health bar effects");
            healthBar.SetActive(false);
            GameObject fillObject = new GameObject("Fill", typeof(RectTransform), typeof(Image));
            fillObject.transform.SetParent(healthBar.transform);
            fill = fillObject.GetComponent<Image>();
            fill.color = baseColor;

            flash = AddEffect("HealthBarDamageFlash");
            pulse = AddEffect("HealthBarLowHealthPulse");
            SetField(flash, "flashSeconds", 0.2f);
            // Hold the pulse at its midpoint so assertions do not depend on the
            // test runner's phase within the animation cycle.
            SetField(pulse, "pulseHz", 0f);
            SetField(pulse, "minAlpha", 0.2f);
            healthBar.SetActive(true);
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            UnityEngine.Object.Destroy(healthBar);
            yield return null;
        }

        [TestCase(1f)]
        [TestCase(0.1f)]
        public void PulsePreservesAnActiveDamageTint(float health01)
        {
            Call(pulse, "SetHealth01", health01);
            Call(flash, "Play");
            Color damageTint = fill.color;
            Assert.That(damageTint.r, Is.GreaterThan(baseColor.r));

            Call(pulse, "Update");

            AssertRgb(fill.color, damageTint);
            Assert.That(fill.color.a, Is.EqualTo(health01 < 0.25f ? 0.6f : baseColor.a).Within(0.001f));
        }

        [UnityTest]
        public IEnumerator DamageFlashPreservesPulseOpacityAndRestoresItsTint()
        {
            Call(pulse, "SetHealth01", 0.1f);
            Call(pulse, "Update");
            Assert.That(fill.color.a, Is.EqualTo(0.6f).Within(0.001f));

            Call(flash, "Play");

            Assert.That(fill.color.r, Is.GreaterThan(baseColor.r));
            Assert.That(fill.color.a, Is.EqualTo(0.6f).Within(0.001f),
                "Damage feedback must not reset the low-health pulse opacity.");

            yield return new WaitForSecondsRealtime(0.3f);

            AssertRgb(fill.color, baseColor);
            Assert.That(fill.color.a, Is.EqualTo(0.6f).Within(0.001f));
            Call(pulse, "SetHealth01", 1f);
            Call(pulse, "Update");
            Assert.That(fill.color, Is.EqualTo(baseColor), "Healing must restore the authored opacity.");
        }

        private MonoBehaviour AddEffect(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null);
            MonoBehaviour effect = (MonoBehaviour)healthBar.AddComponent(type);
            SetField(effect, "fillImage", fill);
            return effect;
        }

        private static void SetField(object target, string name, object value)
        {
            target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
                .SetValue(target, value);
        }

        private static void Call(object target, string name, params object[] args)
        {
            target.GetType().GetMethod(name,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .Invoke(target, args);
        }

        private static void AssertRgb(Color actual, Color expected)
        {
            Assert.That(actual.r, Is.EqualTo(expected.r).Within(0.001f));
            Assert.That(actual.g, Is.EqualTo(expected.g).Within(0.001f));
            Assert.That(actual.b, Is.EqualTo(expected.b).Within(0.001f));
        }
    }
}
