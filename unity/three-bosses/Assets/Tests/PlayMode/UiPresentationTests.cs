using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.EventSystems;
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

            Type feedbackType = RequireType("ButtonHoverFeedback, Assembly-CSharp");
            Component feedback = button.GetComponent(feedbackType);
            Assert.That(feedback, Is.Not.Null);
            Assert.That(GetProperty<bool>(feedback, "HasConfiguredAccent"), Is.True);
            Assert.That(
                GetProperty<Color>(feedback, "AccentColor"),
                Is.EqualTo(new Color(accent.r, accent.g, accent.b, 1f)));

            Color preHoverRendererColor = label.canvasRenderer.GetColor();
            PointerEventData pointerData = new(eventSystem);
            button.OnPointerEnter(pointerData);
            RequireMethod(feedbackType, "OnPointerEnter").Invoke(
                feedback,
                new object[] { pointerData });
            yield return new WaitForSecondsRealtime(0.12f);

            Assert.That(
                label.canvasRenderer.GetColor(),
                Is.Not.EqualTo(preHoverRendererColor));
            Assert.That(label.transform.localScale.x, Is.GreaterThan(1.03f));
            Assert.That(buttonObject.transform.localScale, Is.EqualTo(Vector3.one));

            button.OnPointerExit(pointerData);
            RequireMethod(feedbackType, "OnPointerExit").Invoke(
                feedback,
                new object[] { pointerData });
            yield return new WaitForSecondsRealtime(0.12f);
            Assert.That(label.transform.localScale.x, Is.EqualTo(1f).Within(0.01f));

            eventSystem.SetSelectedGameObject(buttonObject);
            yield return new WaitForSecondsRealtime(0.12f);
            Assert.That(label.transform.localScale.x, Is.GreaterThan(1.02f));
            Assert.That(buttonObject.transform.localScale, Is.EqualTo(Vector3.one));

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
    }
}
