using UnityEngine;

public sealed class Boss2PhaseTransitionVfx : MonoBehaviour
{
    [Header("Particle Systems")]
    [SerializeField] private ParticleSystem auraLoopVfx;
    [SerializeField] private ParticleSystem burstVfx;

    public void PlayStart()
    {
        if (burstVfx != null)
            burstVfx.Play();

        if (auraLoopVfx != null)
            auraLoopVfx.Play();
    }

    public void PlayStop()
    {
        if (auraLoopVfx != null)
            auraLoopVfx.Stop(true, ParticleSystemStopBehavior.StopEmitting);

        if (burstVfx != null && burstVfx.isPlaying)
            burstVfx.Stop(true, ParticleSystemStopBehavior.StopEmitting);
    }
}
