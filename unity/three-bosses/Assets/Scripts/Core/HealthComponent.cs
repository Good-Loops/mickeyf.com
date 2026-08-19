using System;
using UnityEngine;

public sealed class HealthComponent : MonoBehaviour
{
    [Header("Config")]
    [SerializeField, Min(1)]
    private int maxHealth = 100;

    [SerializeField] private int currentHealth = -1; // Negative means "unset", will be set to maxHealth on Awake.

    public int MaxHealth => maxHealth;
    public int CurrentHealth => currentHealth;
    public bool IsDead => currentHealth <= 0;
    public bool IsInvulnerable { get; private set; }

    public event Action<int, int> HealthChanged; // (current, max)
    public event Action Died;

    private void Awake()
    {
        maxHealth = Mathf.Max(1, maxHealth);

        // Treat negative as "unset", keep 0 as intentionally dead.
        if (currentHealth < 0)
            currentHealth = maxHealth;

        currentHealth = Mathf.Clamp(currentHealth, 0, maxHealth);
        RaiseHealthChanged();
    }

    public bool TryTakeDamage(int amount)
    {
        if (IsDead || IsInvulnerable) return false;

        int clamped = Mathf.Max(0, amount);
        if (clamped == 0) return false;

        currentHealth = Mathf.Max(0, currentHealth - clamped);
        RaiseHealthChanged();

        if (currentHealth == 0)
        {
            Died?.Invoke();
        }

        return true;
    }

    public bool TryHeal(int amount)
    {
        if (IsDead) return false;

        int clamped = Mathf.Max(0, amount);
        if (clamped == 0) return false;

        int before = currentHealth;
        currentHealth = Mathf.Min(maxHealth, currentHealth + clamped);

        if (currentHealth != before)
        {
            RaiseHealthChanged();
            return true;
        }

        return false;
    }

    private void RaiseHealthChanged()
    {
        HealthChanged?.Invoke(currentHealth, maxHealth);
    }

    public void SetHealth(int value)
    {
        int clamped = Mathf.Clamp(value, 0, maxHealth);

        if (clamped == currentHealth)
            return;

        currentHealth = clamped;

        RaiseHealthChanged();

        if (currentHealth <= 0)
            Died?.Invoke();
    }

    public void ResetToMax()
    {
        SetHealth(maxHealth);
    }

    public void SetInvulnerable(bool value)
    {
        IsInvulnerable = value;
    }
}
