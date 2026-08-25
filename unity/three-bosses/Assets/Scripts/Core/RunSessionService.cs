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
        DontDestroyOnLoad(gameObject);
    }

    private void OnDestroy()
    {
        if (instance != this)
            return;

        ResumeFromDocumentHidden();
        instance = null;
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

    private sealed class UnityRealtimeClock : IMonotonicClock
    {
        public double NowSeconds => Time.realtimeSinceStartupAsDouble;
    }
}
