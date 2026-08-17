using UnityEngine;

[RequireComponent(typeof(SpriteRenderer))]
public class PlayerHitFlash : MonoBehaviour
{
    [Header("Flash Settings")]
    [SerializeField] private Color flashColor = new Color(1f, 0.3f, 0.3f, 1f);
    [SerializeField] private float flashDuration = 0.12f;

    private SpriteRenderer spriteRenderer;
    private Color originalColor;
    private float flashTimer;
    private bool isFlashing;

    private void Awake()
    {
        spriteRenderer = GetComponent<SpriteRenderer>();
        originalColor = spriteRenderer.color;
    }

    private void Update()
    {
        if (!isFlashing) return;

        flashTimer -= Time.deltaTime;

        if (flashTimer <= 0f)
        {
            spriteRenderer.color = originalColor;
            isFlashing = false;
        }
    }

    public void TriggerFlash()
    {
        spriteRenderer.color = flashColor;
        flashTimer = flashDuration;
        isFlashing = true;
    }
}
