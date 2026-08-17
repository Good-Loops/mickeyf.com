using UnityEngine;

public interface IProjectile
{
    void Init(Vector2 dir, float speed, GameObject impactPrefab);
}
