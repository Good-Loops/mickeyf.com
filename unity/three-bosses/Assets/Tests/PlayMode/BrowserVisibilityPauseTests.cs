using System;
using System.Collections;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace ThreeBosses.Tests
{
    public sealed class BrowserVisibilityPauseTests
    {
        private const string ServiceObjectName = "Three Bosses Run Session";

        private GameObject serviceObject;
        private object service;
        private bool originalAudioPause;
        private float originalTimeScale;

        [SetUp]
        public void SetUp()
        {
            originalAudioPause = AudioListener.pause;
            originalTimeScale = Time.timeScale;
            AudioListener.pause = false;
            Time.timeScale = 1f;

            Type serviceType = RequireRuntimeType("RunSessionService");
            service = serviceType.GetProperty(
                    "Instance",
                    BindingFlags.Public | BindingFlags.Static)
                ?.GetValue(null);
            Assert.That(service, Is.Not.Null);

            serviceObject = ((Component)service).gameObject;
        }

        [Test]
        public void SendMessageContractPausesAndResumesAudioIdempotently()
        {
            Assert.That(serviceObject.name, Is.EqualTo(ServiceObjectName));

            PauseForDocumentHidden();
            PauseForDocumentHidden();

            Assert.That(IsPausedForDocumentHidden(), Is.True);
            Assert.That(AudioListener.pause, Is.True);

            ResumeFromDocumentHidden();
            ResumeFromDocumentHidden();

            Assert.That(IsPausedForDocumentHidden(), Is.False);
            Assert.That(AudioListener.pause, Is.False);
        }

        [Test]
        public void ResumeRestoresAnAudioPauseThatAlreadyExisted()
        {
            AudioListener.pause = true;

            PauseForDocumentHidden();
            ResumeFromDocumentHidden();

            Assert.That(AudioListener.pause, Is.True);
        }

        [Test]
        public void UserPauseComposesWithBrowserVisibilityWithoutResumingEarly()
        {
            BeginPracticeRun();

            Assert.That(TryPauseForUser(), Is.True);
            Assert.That(IsPausedByUser(), Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(0f));
            Assert.That(AudioListener.pause, Is.True);

            PauseForDocumentHidden();
            ResumeFromUserPause();

            Assert.That(IsPausedByUser(), Is.False);
            Assert.That(IsPausedForDocumentHidden(), Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(AudioListener.pause, Is.True);

            ResumeFromDocumentHidden();
            Assert.That(AudioListener.pause, Is.False);
        }

        [Test]
        public void BrowserVisibilityResumeDoesNotClearAnExistingUserPause()
        {
            BeginPracticeRun();

            Assert.That(TryPauseForUser(), Is.True);
            PauseForDocumentHidden();
            ResumeFromDocumentHidden();

            Assert.That(IsPausedForDocumentHidden(), Is.False);
            Assert.That(IsPausedByUser(), Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(0f));
            Assert.That(AudioListener.pause, Is.True);

            ResumeFromUserPause();
            Assert.That(Time.timeScale, Is.EqualTo(1f));
            Assert.That(AudioListener.pause, Is.False);
        }

        [UnityTest]
        public IEnumerator UserPauseFreezesElapsedRunTime()
        {
            BeginPracticeRun();
            yield return new WaitForSecondsRealtime(0.05f);

            double beforePause = GetElapsedSeconds();
            Assert.That(TryPauseForUser(), Is.True);
            yield return new WaitForSecondsRealtime(0.1f);

            Assert.That(GetElapsedSeconds(), Is.EqualTo(beforePause).Within(0.005d));

            ResumeFromUserPause();
            yield return new WaitForSecondsRealtime(0.05f);
            Assert.That(GetElapsedSeconds(), Is.GreaterThan(beforePause + 0.02d));
        }

        [Test]
        public void UserPauseRejectsCountdownAndRestoresItsPreviousTimeScale()
        {
            object session = GetProperty("Session");
            session.GetType().GetMethod("BeginNewRun")?.Invoke(session, null);

            Assert.That(TryPauseForUser(), Is.False);

            BeginPracticeRun();
            Time.timeScale = 0.75f;
            Assert.That(TryPauseForUser(), Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(0f));

            ResumeFromUserPause();
            Assert.That(Time.timeScale, Is.EqualTo(0.75f));
        }

        [UnityTest]
        public IEnumerator DestroyingAReceiverWithBothPauseReasonsRestoresGlobals()
        {
            BeginPracticeRun();
            Assert.That(TryPauseForUser(), Is.True);
            PauseForDocumentHidden();
            Assert.That(AudioListener.pause, Is.True);
            Assert.That(Time.timeScale, Is.EqualTo(0f));

            UnityEngine.Object.Destroy(serviceObject);
            yield return null;

            serviceObject = null;
            service = null;
            Assert.That(AudioListener.pause, Is.False);
            Assert.That(Time.timeScale, Is.EqualTo(1f));
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            if (serviceObject != null)
            {
                ResumeFromUserPause();
                ResumeFromDocumentHidden();
                UnityEngine.Object.Destroy(serviceObject);
                yield return null;
            }

            serviceObject = null;
            service = null;
            AudioListener.pause = originalAudioPause;
            Time.timeScale = originalTimeScale;
        }

        private void PauseForDocumentHidden()
        {
            serviceObject.SendMessage(
                "PauseForDocumentHidden",
                SendMessageOptions.RequireReceiver);
        }

        private void ResumeFromDocumentHidden()
        {
            serviceObject.SendMessage(
                "ResumeFromDocumentHidden",
                SendMessageOptions.RequireReceiver);
        }

        private bool IsPausedForDocumentHidden()
        {
            return (bool)GetProperty("IsPausedForDocumentHidden");
        }

        private bool IsPausedByUser()
        {
            return (bool)GetProperty("IsPausedByUser");
        }

        private bool TryPauseForUser()
        {
            return (bool)InvokeServiceMethod("TryPauseForUser");
        }

        private void ResumeFromUserPause()
        {
            InvokeServiceMethod("ResumeFromUserPause");
        }

        private void BeginPracticeRun()
        {
            object session = GetProperty("Session");
            Type bossIdType = Type.GetType("ThreeBosses.Run.BossId, ThreeBosses.Run");
            Assert.That(bossIdType, Is.Not.Null);
            object bee = Enum.Parse(bossIdType, "Bee");
            MethodInfo beginPractice = session.GetType().GetMethod("BeginPractice");
            Assert.That(beginPractice, Is.Not.Null);
            beginPractice.Invoke(session, new[] { bee });
        }

        private double GetElapsedSeconds()
        {
            object session = GetProperty("Session");
            PropertyInfo property = session.GetType().GetProperty("ElapsedSeconds");
            Assert.That(property, Is.Not.Null);
            return (double)property.GetValue(session);
        }

        private object GetProperty(string name)
        {
            PropertyInfo property = service.GetType().GetProperty(
                name,
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(property, Is.Not.Null);
            return property.GetValue(service);
        }

        private object InvokeServiceMethod(string name)
        {
            MethodInfo method = service.GetType().GetMethod(
                name,
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(method, Is.Not.Null);
            return method.Invoke(service, null);
        }

        private static Type RequireRuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Type {name} was not found.");
            return type;
        }
    }
}
