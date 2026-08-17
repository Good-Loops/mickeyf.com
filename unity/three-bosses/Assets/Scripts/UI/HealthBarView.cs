using UnityEngine;
using UnityEngine.UI;

public sealed class HealthBarView : MonoBehaviour
{
    [Header("UI")]
    [SerializeField] private Image fillImage;

    [Header("FX")]
    [SerializeField] private HealthBarDamageFlash damageFlash;
    [SerializeField] private HealthBarLowHealthPulse lowHealthPulse;
    [SerializeField] private HealthBarSheenSweep sheenSweep;

    private int lastHealth = int.MinValue;

    public void SetHealth(int current, int max)
    {
        max = Mathf.Max(1, max);

        float t = Mathf.Clamp01((float)current / max);

        if (fillImage != null)
            fillImage.fillAmount = t;

        if (lastHealth != int.MinValue && current < lastHealth)
            damageFlash?.Play();

        lastHealth = current;
        lowHealthPulse?.SetHealth01(t);
        sheenSweep?.SetHealth01(t);
    }
}
