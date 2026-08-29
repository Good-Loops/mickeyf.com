using System;
using System.Runtime.InteropServices;
using ThreeBosses.Run;
using UnityEngine;

/// <summary>
/// Owns the active Three Bosses run for the lifetime of the player session.
/// The pure RunSession remains independent from Unity and is easy to test.
/// </summary>
public sealed class RunSessionService : MonoBehaviour
{
    private const string ServiceObjectName = "Three Bosses Run Session";

    private static RunSessionService instance;

    private PausableMonotonicClock sessionClock;
    private RunSubmissionCoordinator submissionCoordinator;
    private bool isPausedForDocumentHidden;
    private bool audioWasPausedBeforeDocumentHidden;

    public static RunSessionService Instance
    {
        get
        {
            EnsureInstance();
            return instance;
        }
    }

    public RunSession Session { get; private set; }
    public bool IsPausedForDocumentHidden => isPausedForDocumentHidden;
    public RunSubmissionStatus SubmissionStatus => submissionCoordinator.Status;
    public string SubmissionErrorCode => submissionCoordinator.LastErrorCode;

    public event Action SubmissionStateChanged;

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void MickeyfThreeBossesSubmitRun(string payloadJson);
#endif

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics()
    {
        instance = null;
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void Bootstrap()
    {
        EnsureInstance();
    }

    private void Awake()
    {
        if (instance != null && instance != this)
        {
            Destroy(gameObject);
            return;
        }

        instance = this;
        gameObject.name = ServiceObjectName;
        sessionClock = new PausableMonotonicClock(new UnityRealtimeClock());
        Session = new RunSession(sessionClock);
        submissionCoordinator = new RunSubmissionCoordinator(Session);
        submissionCoordinator.Changed += OnSubmissionStateChanged;
        DontDestroyOnLoad(gameObject);
    }

    private void OnDestroy()
    {
        if (instance != this)
            return;

        ResumeFromDocumentHidden();
        if (submissionCoordinator != null)
            submissionCoordinator.Changed -= OnSubmissionStateChanged;
        instance = null;
    }

    /// <summary>
    /// WebGL SendMessage endpoint. The browser enables submission only after
    /// the server catalog advertises the release gate as open.
    /// </summary>
    public void ConfigureRunSubmission(string enabledValue)
    {
        submissionCoordinator.ConfigureTransport(enabledValue == "1");
    }

    public void RefreshRunSubmissionState()
    {
        submissionCoordinator.Refresh();
    }

    public bool TrySubmitCurrentRun()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        if (!submissionCoordinator.TryBegin(out RunSubmissionPayload payload))
            return false;

        string payloadJson = JsonUtility.ToJson(new BrowserSubmissionPayload
        {
            runId = payload.RunId,
            completionTimeMs = payload.CompletionTimeMilliseconds
        });

        try
        {
            MickeyfThreeBossesSubmitRun(payloadJson);
            return true;
        }
        catch (Exception exception)
        {
            Debug.LogException(exception, this);
            submissionCoordinator.CompleteFailure(payload.RunId, "NETWORK_ERROR");
            return false;
        }
#else
        Debug.LogWarning("Three Bosses run submission is available only in the WebGL player.", this);
        return false;
#endif
    }

    /// <summary>
    /// WebGL SendMessage endpoint receiving the browser's validated API result.
    /// Unity still verifies that the returned run, time, score, and rank match
    /// the result shown to the player before marking it submitted.
    /// </summary>
    public void ReceiveRunSubmissionResult(string callbackJson)
    {
        BrowserSubmissionCallback callback;
        try
        {
            callback = JsonUtility.FromJson<BrowserSubmissionCallback>(callbackJson);
        }
        catch (ArgumentException)
        {
            callback = null;
        }

        if (callback == null)
        {
            submissionCoordinator.CompleteFailure(string.Empty, "INVALID_RESPONSE");
            return;
        }

        if (!callback.success)
        {
            submissionCoordinator.CompleteFailure(callback.runId, callback.error);
            return;
        }

        BrowserSubmissionResponse response = callback.response;
        BrowserSubmissionResult result = response?.result;
        bool validEnvelope = response != null &&
                             result != null &&
                             response.success &&
                             response.contractVersion == 1 &&
                             response.rulesVersion == 1 &&
                             string.Equals(response.gameId, "three-bosses", StringComparison.Ordinal) &&
                             string.Equals(response.runId, callback.runId, StringComparison.Ordinal);
        if (!validEnvelope)
        {
            submissionCoordinator.CompleteFailure(callback.runId, "INVALID_RESPONSE");
            return;
        }

        submissionCoordinator.CompleteSuccess(
            callback.runId,
            result.completionTimeMs,
            result.score,
            result.rank);
    }

    /// <summary>
    /// WebGL SendMessage endpoint used immediately before the browser host
    /// suspends Unity's main loop.
    /// </summary>
    public void PauseForDocumentHidden()
    {
        if (isPausedForDocumentHidden)
            return;

        sessionClock.Pause();
        audioWasPausedBeforeDocumentHidden = AudioListener.pause;
        AudioListener.pause = true;
        isPausedForDocumentHidden = true;
    }

    /// <summary>
    /// WebGL SendMessage endpoint used immediately before the browser host
    /// resumes Unity's main loop.
    /// </summary>
    public void ResumeFromDocumentHidden()
    {
        if (!isPausedForDocumentHidden)
            return;

        sessionClock.Resume();
        AudioListener.pause = audioWasPausedBeforeDocumentHidden;
        isPausedForDocumentHidden = false;
    }

    private static void EnsureInstance()
    {
        if (instance != null)
            return;

        instance = FindFirstObjectByType<RunSessionService>();
        if (instance != null)
            return;

        var serviceObject = new GameObject(ServiceObjectName);
        instance = serviceObject.AddComponent<RunSessionService>();
    }

    private void OnSubmissionStateChanged()
    {
        SubmissionStateChanged?.Invoke();
    }

    [Serializable]
    private sealed class BrowserSubmissionPayload
    {
        public string runId;
        public int completionTimeMs;
    }

    [Serializable]
    private sealed class BrowserSubmissionCallback
    {
        public bool success;
        public string runId;
        public string error;
        public BrowserSubmissionResponse response;
    }

    [Serializable]
    private sealed class BrowserSubmissionResponse
    {
        public bool success;
        public int contractVersion;
        public string gameId;
        public int rulesVersion;
        public string runId;
        public BrowserSubmissionResult result;
    }

    [Serializable]
    private sealed class BrowserSubmissionResult
    {
        public int score;
        public int completionTimeMs;
        public string rank;
    }

    private sealed class UnityRealtimeClock : IMonotonicClock
    {
        public double NowSeconds => Time.realtimeSinceStartupAsDouble;
    }
}
