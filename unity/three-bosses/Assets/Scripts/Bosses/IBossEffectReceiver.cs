public interface IBossEffectReceiver
{
    bool IsInvulnerable { get; }
    void ApplyFreeze(float seconds);
    void ApplyStunt(float seconds);
}
