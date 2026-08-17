using UnityEngine;

[CreateAssetMenu(fileName = "WeaponData", menuName = "Three Bosses/Weapons/WeaponData")]
public sealed class WeaponData : ScriptableObject
{
    [Header("Identity")]
    public string weaponId = "pulse_blaster";
    public Sprite weaponSprite;

    [Header("Firing")]
    [Min(0.01f)] public float cooldownSeconds = 0.35f;
    [Min(1)] public int maxShots = 8;

    [Header("Projectile")]
    public GameObject projectilePrefab;
    [Min(0.1f)] public float projectileSpeed = 15f;

    [Header("Spread")]
    [Min(1)] public int pelletCount = 1;
    [Min(0f)] public float spreadDegrees = 0f;

    [Header("Muzzle")]
    public float muzzleForwardOffset = 0.2f;
    public float muzzleVerticalOffset = 0f;

    [Header("Impact VFX")]
    public GameObject impactPrefab;

    [Header("Audio")]
    [SerializeField] private AudioClip fireSfx;
    [SerializeField] private AudioClip impactSfx;

    [Range(0f, 1f)]
    [SerializeField] private float fireSfxVolume = 1f;

    [Range(0f, 1f)]
    [SerializeField] private float impactSfxVolume = 1f;

    public AudioClip FireSfx => fireSfx;
    public AudioClip ImpactSfx => impactSfx;
    public float FireSfxVolume => fireSfxVolume;
    public float ImpactSfxVolume => impactSfxVolume;
}
