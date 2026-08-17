using System.Collections;
using UnityEngine;
using UnityEngine.UI;

public sealed class HealthBarSheenSweep : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private RectTransform sheenMask; // the cavity mask rect
    [SerializeField] private RectTransform sheen;     // the moving bar
    [SerializeField] private Image sheenImage;        // for alpha tweaks

    [Header("Rules")]
    [SerializeField, Range(0f, 1f)] private float lowHealthThreshold = 0.25f;

    [Header("Motion")]
    [SerializeField, Min(0.05f)] private float sweepSeconds = 1.1f;
    [SerializeField, Min(0f)] private float restSeconds = 0.6f;

    [Header("Look")]
    [SerializeField, Range(0f, 1f)] private float alpha = 0.12f;

    private float health01 = 1f;
    private Coroutine routine;

    private void Awake()
    {
        if (sheenImage != null)
        {
            var c = sheenImage.color;
            c.a = alpha;
            sheenImage.color = c;
        }
    }

    private void OnEnable()
    {
        StartOrStop();
    }

    private void OnDisable()
    {
        if (routine != null) StopCoroutine(routine);
        routine = null;
    }

    public void SetHealth01(float t)
    {
        health01 = Mathf.Clamp01(t);
        StartOrStop();
    }

    private void StartOrStop()
    {
        var shouldRun = health01 > lowHealthThreshold;

        if (!shouldRun)
        {
            if (routine != null) StopCoroutine(routine);
            routine = null;
            if (sheen != null) sheen.gameObject.SetActive(false);
            return;
        }

        if (routine == null && isActiveAndEnabled)
            routine = StartCoroutine(SweepLoop());
    }

    private IEnumerator SweepLoop()
    {
        if (sheenMask == null || sheen == null)
            yield break;

        sheen.gameObject.SetActive(true);

        while (true)
        {
            // If we dip into low health mid-loop, stop immediately.
            if (health01 <= lowHealthThreshold)
            {
                sheen.gameObject.SetActive(false);
                routine = null;
                yield break;
            }

            var maskW = sheenMask.rect.width;
            var sheenW = sheen.rect.width;

            var startX = -sheenW * 2f;
            var endX   = maskW + sheenW * 2f;

            var t = 0f;
            while (t < sweepSeconds)
            {
                if (health01 <= lowHealthThreshold)
                {
                    sheen.gameObject.SetActive(false);
                    routine = null;
                    yield break;
                }

                t += Time.unscaledDeltaTime;
                var u = Mathf.Clamp01(t / sweepSeconds);

                var x = Mathf.Lerp(startX, endX, u);
                var p = sheen.anchoredPosition;
                p.x = x;
                sheen.anchoredPosition = p;

                yield return null;
            }

            yield return new WaitForSecondsRealtime(restSeconds);
        }
    }
}
