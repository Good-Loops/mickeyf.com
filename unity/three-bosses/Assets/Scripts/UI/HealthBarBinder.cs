using UnityEngine;

public sealed class HealthBarBinder : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private HealthComponent health;
    [SerializeField] private HealthBarView view;

    private void OnEnable()
    {
        if (health == null || view == null) return;

        health.HealthChanged += OnHealthChanged;

        view.SetHealth(health.CurrentHealth, health.MaxHealth);
    }

    private void OnDisable()
    {
        if (health == null) return;
        health.HealthChanged -= OnHealthChanged;
    }

    private void OnHealthChanged(int current, int max)
    {
        view.SetHealth(current, max);
    }
}
