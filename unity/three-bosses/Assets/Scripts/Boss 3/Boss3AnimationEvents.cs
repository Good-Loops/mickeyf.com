using UnityEngine;

public sealed class Boss3AnimationEvents : MonoBehaviour
{
    [SerializeField] private Boss3Controller controller;

    public void AE_FireMissile()
    {
        if (controller == null)
        {
            Debug.LogWarning("Boss3AnimationEvents: controller is null.", this);
            return;
        }

        controller.AE_FireMissile();
    }

    public void AE_CastRunes()
    {
        if (controller != null)
        {
            controller.AE_CastRunes();
        }
        else
        {
            Debug.LogWarning("Boss3AnimationEvents: controller reference is null.", this);
        }
    }

    public void AE_DeathFinished()
    {
        controller.AE_DeathFinished();
    }
}
