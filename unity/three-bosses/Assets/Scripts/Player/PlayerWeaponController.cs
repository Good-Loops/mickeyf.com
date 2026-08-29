using UnityEngine;
using UnityEngine.InputSystem;

public enum AimDir { Front, Back, Up }

public sealed class PlayerWeaponController : MonoBehaviour
{
    [Header("Refs")]
    [SerializeField] private SpriteRenderer weaponRenderer;
    [SerializeField] private Transform weaponVisual; // same object as weaponRenderer transform
    [SerializeField] private Transform projectileSpawn; // optional; can reuse weaponVisual
    [SerializeField] private HealthComponent health; // owner health

    [Header("Offsets")]
    [SerializeField] private Vector2 frontOffset = new(0.6f, 0.1f);
    [SerializeField] private Vector2 backOffset  = new(-0.6f, 0.1f);
    [SerializeField] private Vector2 upOffset    = new(0.0f, 1.2f);

    [Header("Bobbing")]
    [SerializeField] private float bobAmplitude = 0.07f;
    [SerializeField] private float bobFrequency = 2.5f;

    [Header("Recoil")]
    [SerializeField] private float recoilDistance = 0.12f;
    [SerializeField] private float recoilReturnSpeed = 18f;

    private WeaponData current;
    private AimDir aimDir = AimDir.Front;
    private Vector2 recoilOffset;
    private int shotsRemaining;
    private float nextFireTime;
    private bool isLocked;
    private bool aimUpPressed;
    private bool aimBackPressed;
    private bool aimFrontPressed;

    private void Awake()
    {
        weaponRenderer.enabled = false;
    }

    private void Update()
    {
        if (isLocked || (health != null && health.IsDead))
            return;

        UpdateWeaponTransform();
    }

    private void OnEnable()
    {
        if (health != null) health.Died += OnOwnerDied;
    }

    private void OnDisable()
    {
        if (health != null) health.Died -= OnOwnerDied;
        aimUpPressed = false;
        aimBackPressed = false;
        aimFrontPressed = false;
    }

    private void OnOwnerDied()
    {
        isLocked = true;
        Unequip();
        recoilOffset = Vector2.zero;
    }

    public void Equip(WeaponData weapon)
    {
        current = weapon;
        shotsRemaining = weapon.maxShots;
        nextFireTime = Time.time; // can fire immediately
        weaponRenderer.sprite = weapon.weaponSprite;
        weaponRenderer.enabled = true;
    }

    private void Unequip()
    {
        current = null;
        weaponRenderer.enabled = false;
        weaponRenderer.sprite = null;
    }

    private void OnAimUp(InputValue value)
    {
        aimUpPressed = value.isPressed;
        ResolveAimDirection();
    }

    private void OnAimBack(InputValue value)
    {
        aimBackPressed = value.isPressed;
        ResolveAimDirection();
    }

    private void OnAimFront(InputValue value)
    {
        aimFrontPressed = value.isPressed;
        ResolveAimDirection();
    }

    private void OnFire(InputValue value)
    {
        if (!value.isPressed || !isActiveAndEnabled || isLocked ||
            (health != null && health.IsDead) || current == null)
            return;

        TryFire();
    }

    private void ResolveAimDirection()
    {
        aimDir = ResolveAimDirection(
            aimUpPressed,
            aimBackPressed,
            aimFrontPressed,
            aimDir);
    }

    private static AimDir ResolveAimDirection(
        bool aimUp,
        bool aimBack,
        bool aimFront,
        AimDir currentAim)
    {
        if (aimUp)
            return AimDir.Up;
        if (aimBack)
            return AimDir.Back;
        if (aimFront)
            return AimDir.Front;

        return currentAim;
    }

    private void UpdateWeaponTransform()
    {
        Vector2 offset = aimDir switch
        {
            AimDir.Front => frontOffset,
            AimDir.Back  => backOffset,
            _            => upOffset
        };

        // Rotate only for Up, flip for Back (no 180 rotation)
        weaponVisual.localRotation = (aimDir == AimDir.Up)
            ? Quaternion.Euler(0f, 0f, 90f)
            : Quaternion.identity;

        weaponVisual.localScale = (aimDir == AimDir.Back)
            ? new Vector3(-1f, 1f, 1f)
            : Vector3.one;

        float bob = Mathf.Sin(Time.time * (Mathf.PI * 2f) * bobFrequency) * bobAmplitude;

        // recoilOffset eases back to zero
        recoilOffset = Vector2.Lerp(recoilOffset, Vector2.zero, recoilReturnSpeed * Time.deltaTime);

        weaponVisual.localPosition = offset + new Vector2(0f, bob) + recoilOffset;
    }

    private void TryFire()
    {
        if (Time.time < nextFireTime)
            return;

        if (shotsRemaining <= 0)
        {
            Unequip();
            return;
        }

        nextFireTime = Time.time + current.cooldownSeconds;
        shotsRemaining--;
        SfxPlayer.PlayOneShot(current.FireSfx, current.FireSfxVolume);

        Vector2 dir = aimDir switch
        {
            AimDir.Front => Vector2.right,
            AimDir.Back  => Vector2.left,
            _            => Vector2.up
        };

        int count = Mathf.Max(1, current.pelletCount);
        float totalSpread = Mathf.Max(0f, current.spreadDegrees);

        float baseAngle = DirToAngleDeg(dir);
        float step = (count == 1) ? 0f : totalSpread / (count - 1);
        float start = -totalSpread * 0.5f;

        // base point (weapon mount)
        Vector3 basePos = (weaponVisual != null) ? weaponVisual.position : transform.position;

        // local muzzle offset (authoring time, facing RIGHT)
        Vector3 localMuzzle = projectileSpawn != null ? projectileSpawn.localPosition : Vector3.zero;

        for (int i = 0; i < count; i++)
        {
            float pelletAngle = baseAngle + start + (step * i);
            Vector2 pelletDir = AngleDegToDir(pelletAngle);

            // rotate local muzzle offset to match THIS pellet direction
            Vector3 rotatedMuzzle = Quaternion.Euler(0f, 0f, pelletAngle) * localMuzzle;

            // final spawn position
            Vector3 spawnPos = basePos + rotatedMuzzle;
            spawnPos += (Vector3)(pelletDir.normalized * current.muzzleForwardOffset);
            spawnPos += Vector3.up * current.muzzleVerticalOffset;

            Quaternion rot = Quaternion.Euler(0f, 0f, pelletAngle);

            var projectile = Instantiate(current.projectilePrefab, spawnPos, rot);

            var p = projectile.GetComponent<IProjectile>();
            if (p == null)
            {
                Debug.LogError($"Projectile prefab '{projectile.name}' is missing an IProjectile component.");
                Destroy(projectile);
                return;
            }

            if (p is IImpactSfxReceiver impactSfxReceiver)
            {
                impactSfxReceiver.SetImpactSfx(
                    current.ImpactSfx,
                    current.ImpactSfxVolume
                );
            }

            p.Init(
                pelletDir,
                current.projectileSpeed,
                current.impactPrefab
            );
        }

        // physical recoil (opposite direction)
        recoilOffset += -dir * recoilDistance;

        if (shotsRemaining <= 0)
            Unequip();
    }

    private static float DirToAngleDeg(Vector2 dir)
    {
        return Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg;
    }

    private static Vector2 AngleDegToDir(float angleDeg)
    {
        float rad = angleDeg * Mathf.Deg2Rad;
        return new Vector2(Mathf.Cos(rad), Mathf.Sin(rad));
    }
}
