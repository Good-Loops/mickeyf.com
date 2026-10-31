using System;
using System.Reflection;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace ThreeBosses.Tests
{
    public sealed class EditorSceneWorkspaceTests
    {
        private SceneSetup[] originalSetup;
        private string testFolder;

        [SetUp]
        public void SetUp()
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
                Assert.That(SceneManager.GetSceneAt(i).isDirty, Is.False,
                    "These tests must not replace a user's unsaved scene.");
            originalSetup = EditorSceneManager.GetSceneManagerSetup();
            string folderName = "__EditorSceneWorkspaceTests_" + Guid.NewGuid().ToString("N");
            testFolder = "Assets/" + folderName;
            Assert.That(AssetDatabase.CreateFolder("Assets", folderName), Is.Not.Empty);
        }

        [TearDown]
        public void TearDown()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            if (originalSetup != null && originalSetup.Length > 0 &&
                Array.Exists(originalSetup, scene => scene.isActive && scene.isLoaded) &&
                Array.TrueForAll(originalSetup, scene => !string.IsNullOrEmpty(scene.path)))
                EditorSceneManager.RestoreSceneManagerSetup(originalSetup);
            if (testFolder != null)
                AssetDatabase.DeleteAsset(testFolder);
        }

        [Test]
        public void OpenMainMenuProtectsDirtyAdditiveScene()
        {
            AssertProtectsDirtyAdditiveScene("MainMenuAndCountdownBuilder", "OpenMainMenu");
        }

        [TestCase("RunTimerDisplayBuilder", "Build")]
        [TestCase("MainMenuAndCountdownBuilder", "RebuildLevelOneCountdown")]
        public void BuildersProtectDirtyAdditiveScene(string typeName, string methodName)
        {
            AssertProtectsDirtyAdditiveScene(typeName, methodName);
        }

        [TestCase(false)]
        [TestCase(true)]
        public void RebuildScopeRestoresAllOpenScenesAndTheActiveScene(bool buildFails)
        {
            Scene first = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            Assert.That(EditorSceneManager.SaveScene(first, testFolder + "/First.unity"), Is.True);
            Scene second = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            Assert.That(EditorSceneManager.SaveScene(second, testFolder + "/Second.unity"), Is.True);
            SceneManager.SetActiveScene(first);
            SceneSetup[] expected = EditorSceneManager.GetSceneManagerSetup();
            bool buildRan = false;

            Action build = () =>
            {
                buildRan = true;
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                if (buildFails)
                    throw new InvalidOperationException("Synthetic build failure");
            };

            if (buildFails)
            {
                TargetInvocationException error = Assert.Throws<TargetInvocationException>(() => RunBuild(build));
                Assert.That(error.InnerException.Message, Is.EqualTo("Synthetic build failure"));
            }
            else
            {
                RunBuild(build);
            }

            Assert.That(buildRan, Is.True);
            SceneSetup[] actual = EditorSceneManager.GetSceneManagerSetup();
            Assert.That(actual.Length, Is.EqualTo(expected.Length));
            for (int i = 0; i < expected.Length; i++)
            {
                Assert.That(actual[i].path, Is.EqualTo(expected[i].path));
                Assert.That(actual[i].isLoaded, Is.EqualTo(expected[i].isLoaded));
                Assert.That(actual[i].isActive, Is.EqualTo(expected[i].isActive));
            }
        }

        [Test]
        public void RebuildScopeRejectsAnUntitledSceneBeforeRunningTheBuilder()
        {
            Scene untitled = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            bool buildRan = false;

            TargetInvocationException error = Assert.Throws<TargetInvocationException>(() =>
                RunBuild(() => buildRan = true));

            Assert.That(error.InnerException, Is.TypeOf<InvalidOperationException>());
            Assert.That(buildRan, Is.False);
            Assert.That(SceneManager.GetActiveScene(), Is.EqualTo(untitled));
        }

        private void AssertProtectsDirtyAdditiveScene(string typeName, string methodName)
        {
            Scene active = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            Assert.That(EditorSceneManager.SaveScene(active, testFolder + "/Active.unity"), Is.True);
            Scene additive = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            SceneManager.SetActiveScene(additive);
            GameObject unsavedObject = new GameObject("Unsaved additive work");
            SceneManager.MoveGameObjectToScene(unsavedObject, additive);
            EditorSceneManager.MarkSceneDirty(additive);
            SceneManager.SetActiveScene(active);
            Assert.That(active.isDirty, Is.False);
            Assert.That(additive.isDirty, Is.True);

            TargetInvocationException error = Assert.Throws<TargetInvocationException>(() =>
                EditorType(typeName).GetMethod(methodName).Invoke(null, null));

            Assert.That(error.InnerException, Is.TypeOf<InvalidOperationException>());
            Assert.That(SceneManager.GetActiveScene(), Is.EqualTo(active));
            Assert.That(additive.isLoaded, Is.True);
            Assert.That(unsavedObject != null, Is.True);
        }

        private static void RunBuild(Action build)
        {
            EditorType("EditorSceneWorkspace").GetMethod("RunWithRestoredScenes")
                .Invoke(null, new object[] { "testing scene restoration", build });
        }

        private static Type EditorType(string name)
        {
            Type type = Type.GetType($"{name}, Assembly-CSharp-Editor");
            Assert.That(type, Is.Not.Null);
            return type;
        }
    }
}
