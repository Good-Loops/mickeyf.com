using System.Collections;
using UnityEngine;

public sealed class HitFlash2D : MonoBehaviour
{
    [SerializeField] private SpriteRenderer sr;
    [SerializeField] private float flashSeconds = 0.08f;

    private Coroutine routine;
    private Color baseColor;

    private void Awake()
    {
        if (sr == null) sr = GetComponentInChildren<SpriteRenderer>();
        baseColor = sr != null ? sr.color : Color.white;
    }

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (sr == null) sr = GetComponentInChildren<SpriteRenderer>();
    }
#endif

    public void Flash()
    {
        if (sr == null) return;

        if (routine != null) StopCoroutine(routine);
        routine = StartCoroutine(FlashRoutine());
    }

    private IEnumerator FlashRoutine()
    {
        sr.color = Color.red;
        yield return new WaitForSeconds(flashSeconds);
        sr.color = baseColor;
        routine = null;
    }
}
