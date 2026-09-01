using System.Collections;
using ThreeBosses.Run;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.Serialization;

public sealed class BossDefeatSceneLoader : MonoBehaviour
{
    [SerializeField] private HealthComponent bossHealth;
    [SerializeField] private BossId bossId = BossId.Bee;
    [SerializeField, FormerlySerializedAs("nextSceneName")]
    private string transitionSceneName = "BossTransition";
    [SerializeField] private string endSceneName = "End";

    [Header("Timing")]
    [SerializeField, Min(0f)] private float loadDelaySeconds = 5f;
    [SerializeField, Min(0f)] private float fadeDurationSeconds = 0.75f;
    [SerializeField, Min(0f)] private float fadeStartDelaySeconds = 0.5f;

    [Header("Optional")]
    [SerializeField] private ScreenFade screenFade;
    [SerializeField] private PlayerDeathHandler playerDeathHandler;

    private bool hasStartedTransition;

    private void Awake()
    {
        if (playerDeathHandler == null)
            playerDeathHandler = FindFirstObjectByType<PlayerDeathHandler>();
    }

    private void OnEnable()
    {
        if (bossHealth != null)
            bossHealth.Died += OnBossDied;
    }

    private void OnDisable()
    {
        if (bossHealth != null)
            bossHealth.Died -= OnBossDied;
    }

    private void OnBossDied()
    {
        if (hasStartedTransition)
            return;

        BossDefeatResult result = RunSessionService.Instance.Session.RecordBossDefeat(bossId);
        if (result == BossDefeatResult.Rejected)
        {
            Debug.LogWarning($"Ignored an out-of-sequence {bossId} defeat.", this);
            return;
        }

        string destinationSceneName = result == BossDefeatResult.RunCompleted
            ? endSceneName
            : transitionSceneName;

        if (string.IsNullOrWhiteSpace(destinationSceneName))
        {
            Debug.LogError($"No destination scene is configured for {bossId} defeat.", this);
            return;
        }

        hasStartedTransition = true;
        playerDeathHandler?.LockForBossDefeat();
        StartCoroutine(LoadSceneAfterDelay(destinationSceneName));
    }

    private IEnumerator LoadSceneAfterDelay(string destinationSceneName)
    {
        if (fadeStartDelaySeconds > 0f)
            yield return new WaitForSecondsRealtime(fadeStartDelaySeconds);

        if (screenFade != null)
            screenFade.FadeIn(fadeDurationSeconds);

        float remainingDelay = Mathf.Max(0f, loadDelaySeconds - fadeStartDelaySeconds);
        if (remainingDelay > 0f)
            yield return new WaitForSecondsRealtime(remainingDelay);

        SceneManager.LoadScene(destinationSceneName);
    }
}
