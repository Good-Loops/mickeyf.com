using UnityEngine;

public sealed class WeaponCratePickup : MonoBehaviour
{
    [SerializeField] private WeaponData[] possibleWeapons;

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (!other.TryGetComponent<PlayerWeaponController>(out var weaponController))
            return;

        var weapon = GetRandomWeapon();
        if (weapon != null)
        {
            weaponController.Equip(weapon);
        }
        Destroy(gameObject);
    }

    private WeaponData GetRandomWeapon()
    {
        if (possibleWeapons == null || possibleWeapons.Length == 0)
            return null;

        int index = Random.Range(0, possibleWeapons.Length);
        return possibleWeapons[index];
    }
}
