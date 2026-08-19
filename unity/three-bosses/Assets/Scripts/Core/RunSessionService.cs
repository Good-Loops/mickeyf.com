using ThreeBosses.Run;
using UnityEngine;

/// <summary>
/// Owns the active Three Bosses run for the lifetime of the player session.
/// The pure RunSession remains independent from Unity and is easy to test.
/// </summary>
public sealed class RunSessionService : MonoBehaviour
{
    private static RunSessionService instance;

    public static RunSessionService Instance
    {
        get
        {
            EnsureInstance();
            return instance;
        }
    }

    public RunSession Session { get; private set; }

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
        Session ??= new RunSession(new UnityRealtimeClock());
        DontDestroyOnLoad(gameObject);
    }

    private static void EnsureInstance()
    {
        if (instance != null)
            return;

        instance = FindFirstObjectByType<RunSessionService>();
        if (instance != null)
            return;

        var serviceObject = new GameObject("Three Bosses Run Session");
        instance = serviceObject.AddComponent<RunSessionService>();
    }

    private sealed class UnityRealtimeClock : IMonotonicClock
    {
        public double NowSeconds => Time.realtimeSinceStartupAsDouble;
    }
}
