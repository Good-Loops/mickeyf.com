using UnityEngine;

public sealed class DamageFlashOnHealthChange : MonoBehaviour
{
    [SerializeField] private HealthComponent health;
    [SerializeField] private HitFlash2D flash;

    private int lastHealth;

    private void OnEnable()
    {
        if (health == null) return;
        lastHealth = health.CurrentHealth;
        health.HealthChanged += OnHealthChanged;
    }

    private void OnDisable()
    {
        if (health == null) return;
        health.HealthChanged -= OnHealthChanged;
    }

    private void OnHealthChanged(int current, int max)
    {
        if (current < lastHealth)
            flash?.Flash();

        lastHealth = current;
    }
}
