using System.Collections;
using UnityEngine;

public sealed class PhaseAnchorZone : MonoBehaviour
{
    [Header("Lifetime")]
    [SerializeField] private float lifetimeSeconds = 5f;

    [SerializeField] private float interval = 0.6f;
    [SerializeField] private float pauseSeconds = 0.2f;

    [SerializeField] private int openingBurstPulses = 3;
    [SerializeField] private float openingBurstInterval = 0.20f;
    [SerializeField] private float openingBurstPause = 0.25f;

    private IBossEffectReceiver boss;
    private Coroutine loop;

    private void OnEnable()
    {
        if (lifetimeSeconds > 0f)
            Destroy(gameObject, lifetimeSeconds);
    }

    public void Init(IBossEffectReceiver targetBoss)
    {
        boss = targetBoss;

        if (!gameObject.activeInHierarchy)
        {
            gameObject.SetActive(true);
        }

        if (loop != null) StopCoroutine(loop);
        loop = StartCoroutine(PulseLoop());
    }

    private IEnumerator PulseLoop()
    {
        for (int i = 0; i < openingBurstPulses && boss != null; i++)
        {
            if (!boss.IsInvulnerable)
                boss.ApplyStunt(openingBurstPause);
            yield return new WaitForSeconds(openingBurstInterval);
        }

        while (boss != null)
        {
            if (!boss.IsInvulnerable)
                boss.ApplyStunt(pauseSeconds);
            yield return new WaitForSeconds(interval);
        }
    }
}
