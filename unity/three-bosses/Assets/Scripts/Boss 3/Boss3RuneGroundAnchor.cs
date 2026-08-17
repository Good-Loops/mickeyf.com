using UnityEngine;

public sealed class Boss3RuneGroundAnchor : MonoBehaviour
{
    [SerializeField] private bool isEnabled = true;

    public bool IsEnabled => isEnabled;
    public Vector2 Position => transform.position;

#if UNITY_EDITOR
    private void OnDrawGizmos()
    {
        Gizmos.color = isEnabled ? Color.cyan : Color.gray;
        Gizmos.DrawWireSphere(transform.position, 0.2f);
    }
#endif
}
