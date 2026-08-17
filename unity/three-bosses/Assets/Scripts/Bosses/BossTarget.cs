using UnityEngine;

public sealed class BossTarget : MonoBehaviour
{
    [Tooltip("Optional: where the lightning should land. If null, uses transform.")]
    [SerializeField] private Transform aimPoint;

    public Transform AimPoint => aimPoint != null ? aimPoint : transform;
}
