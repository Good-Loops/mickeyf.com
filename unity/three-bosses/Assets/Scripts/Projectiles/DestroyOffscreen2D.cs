using UnityEngine;

public sealed class DestroyOffscreen2D : MonoBehaviour
{
    [SerializeField] private Camera targetCamera;
    [SerializeField, Min(0f)] private float marginWorldUnits = 1.5f;

    private void Awake()
    {
        if (targetCamera == null)
            targetCamera = Camera.main;
    }

    private void LateUpdate()
    {
        if (targetCamera == null || !targetCamera.orthographic)
            return;

        Vector3 camPos = targetCamera.transform.position;

        float halfH = targetCamera.orthographicSize;
        float halfW = halfH * targetCamera.aspect;

        float minX = camPos.x - halfW - marginWorldUnits;
        float maxX = camPos.x + halfW + marginWorldUnits;
        float minY = camPos.y - halfH - marginWorldUnits;
        float maxY = camPos.y + halfH + marginWorldUnits;

        Vector3 p = transform.position;

        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY)
            Destroy(gameObject);
    }
}
