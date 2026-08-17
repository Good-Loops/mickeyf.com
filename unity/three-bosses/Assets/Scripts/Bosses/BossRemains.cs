using System.Collections;
using UnityEngine;

[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(Rigidbody2D))]
[RequireComponent(typeof(Collider2D))]
public sealed class BossRemains : MonoBehaviour
{
    [SerializeField] private Collider2D col;

    [Header("Timing")]
    [SerializeField] private float settleSeconds = 2f;
    [SerializeField] private float holdSeconds = 1.5f;
    [SerializeField] private float blinkSeconds = 3f;
    [SerializeField] private float blinkHz = 12f;

    private SpriteRenderer sr;

    private void Awake()
    {
        sr = GetComponent<SpriteRenderer>();
        if (col == null) col = GetComponent<Collider2D>();
    }

    public void Init(Sprite sprite)
    {
        sr.sprite = sprite;
        StartCoroutine(BlinkAndDie());
    }

    private IEnumerator BlinkAndDie()
    {
        // allow it to fall/settle
        yield return new WaitForSeconds(settleSeconds);

        // Hold for a moment before blinking
        yield return new WaitForSeconds(holdSeconds);

        // Now blink: start slow -> end fast
        float t = 0f;

        // These are rates (toggles per second)
        float startHz = 3f;
        float endHz = blinkHz; // keep your inspector value as the max (e.g. 10–14)

        bool visible = true;
        sr.enabled = true;

        while (t < blinkSeconds)
        {
            float u = t / blinkSeconds;              // 0..1
            float hz = Mathf.Lerp(startHz, endHz, u); // ramp speed
            float step = 1f / Mathf.Max(1f, hz);

            visible = !visible;
            sr.enabled = visible;

            yield return new WaitForSeconds(step);
            t += step;
        }

        sr.enabled = false;
        Destroy(gameObject);
    }
}
