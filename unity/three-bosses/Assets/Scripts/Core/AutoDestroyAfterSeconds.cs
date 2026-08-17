using UnityEngine;

public sealed class AutoDestroyAfterSeconds : MonoBehaviour
{
    [SerializeField, Min(0.01f)] private float seconds = 0.2f;

    private void Start()
    {
        Destroy(gameObject, seconds);
    }
}
