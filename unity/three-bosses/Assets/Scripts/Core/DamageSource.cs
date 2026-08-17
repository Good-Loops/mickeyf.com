using UnityEngine;

public sealed class DamageSource : MonoBehaviour
{
    [SerializeField] private DamageFaction faction = DamageFaction.Player;
    public DamageFaction Faction => faction;
}
