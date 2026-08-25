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

        [SetUp]
        public void SetUp()
        {
            originalAudioPause = AudioListener.pause;
            AudioListener.pause = false;

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

        [UnityTest]
        public IEnumerator DestroyingAHiddenReceiverRestoresGlobalAudioState()
        {
            PauseForDocumentHidden();
            Assert.That(AudioListener.pause, Is.True);

            UnityEngine.Object.Destroy(serviceObject);
            yield return null;

            serviceObject = null;
            service = null;
            Assert.That(AudioListener.pause, Is.False);
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            if (serviceObject != null)
            {
                ResumeFromDocumentHidden();
                UnityEngine.Object.Destroy(serviceObject);
                yield return null;
            }

            serviceObject = null;
            service = null;
            AudioListener.pause = originalAudioPause;
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
            PropertyInfo property = service.GetType().GetProperty(
                "IsPausedForDocumentHidden",
                BindingFlags.Instance | BindingFlags.Public);
            Assert.That(property, Is.Not.Null);
            return (bool)property.GetValue(service);
        }

        private static Type RequireRuntimeType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp");
            Assert.That(type, Is.Not.Null, $"Type {name} was not found.");
            return type;
        }
    }
}
