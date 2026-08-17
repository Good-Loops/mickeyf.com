using UnityEngine;

public sealed class Boss2TeleportVfx : MonoBehaviour
{
    [Header("References")]
    [SerializeField] private Boss2Mover mover;

    [Header("Particle Systems")]
    [SerializeField] private ParticleSystem chargeEffect;
    [SerializeField] private ParticleSystem teleportOutEffect;
    [SerializeField] private ParticleSystem teleportInEffect;

    private void Awake()
    {
        if (mover == null)
            mover = GetComponentInParent<Boss2Mover>();
    }

    private void OnEnable()
    {
        if (mover == null) return;

        mover.OnTeleportChargeStarted += HandleTeleportChargeStarted;
        mover.OnTeleportOutStarted += HandleTeleportOutStarted;
        mover.OnTeleportInStarted += HandleTeleportInStarted;
        mover.OnTeleportFinished += HandleTeleportFinished;
    }

    private void OnDisable()
    {
        if (mover == null) return;

        mover.OnTeleportChargeStarted -= HandleTeleportChargeStarted;
        mover.OnTeleportOutStarted -= HandleTeleportOutStarted;
        mover.OnTeleportInStarted -= HandleTeleportInStarted;
        mover.OnTeleportFinished -= HandleTeleportFinished;
    }

    private void HandleTeleportChargeStarted()
    {
        Play(chargeEffect);
    }

    private void HandleTeleportOutStarted()
    {
        Stop(chargeEffect);
        Play(teleportOutEffect);
    }

    private void HandleTeleportInStarted()
    {
        Play(teleportInEffect);
    }

    private void HandleTeleportFinished()
    {
        Stop(chargeEffect);
    }

    private static void Play(ParticleSystem effect)
    {
        if (effect == null) return;

        effect.gameObject.SetActive(true);
        effect.Play(true);
    }

    private static void Stop(ParticleSystem effect)
    {
        if (effect == null) return;

        effect.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
    }
}
