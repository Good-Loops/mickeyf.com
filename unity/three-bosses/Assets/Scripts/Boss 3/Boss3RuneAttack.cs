using System.Collections;
using System.Collections.Generic;
using UnityEngine;

public sealed class Boss3RuneAttack : MonoBehaviour
{
    [Header("References")]
    [SerializeField] private Transform playerTarget;
    [SerializeField] private GameObject runeWarningPrefab;
    [SerializeField] private GameObject runeExplosionPrefab;
    [SerializeField] private Transform anchorContainer;
    [SerializeField] private Boss3RuneGroundAnchor[] groundAnchors;

    [Header("Timing")]
    [SerializeField] private float warningDuration = 0.9f;
    [SerializeField] private float explosionDuration = 0.2f;

    private bool isPaused;
    private bool isCancelled;
    private List<GameObject> activeWarnings = new();

    private void Awake()
    {
        if (anchorContainer == null)
        {
            groundAnchors = GetComponentsInChildren<Boss3RuneGroundAnchor>();
            return;
        }

        groundAnchors = anchorContainer.GetComponentsInChildren<Boss3RuneGroundAnchor>();
    }

    private void OnDisable()
    {
        DestroyActiveWarnings();
    }

    public void BeginAttack()
    {
        isCancelled = false;
        isPaused = false;
        DestroyActiveWarnings();
    }

    public IEnumerator Execute(bool isPhaseTwo)
    {
        if (isPaused || isCancelled) yield break;

        if (playerTarget == null || runeWarningPrefab == null || runeExplosionPrefab == null)
        {
            Debug.LogWarning("Boss3RuneAttack is missing references.", this);
            yield break;
        }

        List<Boss3RuneGroundAnchor> selectedAnchors = SelectAnchors(isPhaseTwo);

        if (selectedAnchors.Count == 0)
        {
            yield break;
        }

        activeWarnings = SpawnWarnings(selectedAnchors);

        yield return new WaitForSeconds(warningDuration);

        if (isPaused || isCancelled)
        {
            DestroyActiveWarnings();
            yield break;
        }

        DestroyActiveWarnings();
        SpawnExplosions(selectedAnchors);

        yield return new WaitForSeconds(explosionDuration);

        if (isPaused || isCancelled)
        {
            yield break;
        }
    }

    private List<Boss3RuneGroundAnchor> SelectAnchors(bool isPhaseTwo)
    {
        List<Boss3RuneGroundAnchor> result = new();
        List<Boss3RuneGroundAnchor> validAnchors = GetValidAnchors();

        if (validAnchors.Count == 0 || playerTarget == null)
        {
            return result;
        }

        float playerX = playerTarget.position.x;

        Boss3RuneGroundAnchor centerAnchor = FindClosestAnchorByX(validAnchors, playerX);
        TryAddUnique(result, centerAnchor);

        Boss3RuneGroundAnchor leftAnchor = FindClosestAnchorOnSide(validAnchors, centerAnchor, searchLeft: true);
        Boss3RuneGroundAnchor rightAnchor = FindClosestAnchorOnSide(validAnchors, centerAnchor, searchLeft: false);

        if (!isPhaseTwo)
        {
            Boss3RuneGroundAnchor nearbyAnchor = ChooseRandomNearbyAnchor(leftAnchor, rightAnchor);
            TryAddUnique(result, nearbyAnchor);
            return result;
        }

        TryAddUnique(result, leftAnchor);
        TryAddUnique(result, rightAnchor);

        return result;
    }

    private Boss3RuneGroundAnchor FindClosestAnchorOnSide(
        List<Boss3RuneGroundAnchor> anchors,
        Boss3RuneGroundAnchor centerAnchor,
        bool searchLeft)
    {
        if (centerAnchor == null)
        {
            return null;
        }

        Boss3RuneGroundAnchor best = null;
        float bestDistance = float.MaxValue;
        float centerX = centerAnchor.Position.x;

        foreach (Boss3RuneGroundAnchor anchor in anchors)
        {
            if (anchor == null || anchor == centerAnchor)
            {
                continue;
            }

            float deltaX = anchor.Position.x - centerX;

            if (searchLeft && deltaX >= 0f)
            {
                continue;
            }

            if (!searchLeft && deltaX <= 0f)
            {
                continue;
            }

            float distance = Mathf.Abs(deltaX);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = anchor;
            }
        }

        return best;
    }

    private Boss3RuneGroundAnchor ChooseRandomNearbyAnchor(
        Boss3RuneGroundAnchor leftAnchor,
        Boss3RuneGroundAnchor rightAnchor)
    {
        if (leftAnchor != null && rightAnchor != null)
        {
            return Random.value < 0.5f ? leftAnchor : rightAnchor;
        }

        if (leftAnchor != null)
        {
            return leftAnchor;
        }

        return rightAnchor;
    }

    private List<Boss3RuneGroundAnchor> GetValidAnchors()
    {
        List<Boss3RuneGroundAnchor> valid = new();

        if (groundAnchors == null)
        {
            return valid;
        }

        foreach (Boss3RuneGroundAnchor anchor in groundAnchors)
        {
            if (anchor == null || !anchor.IsEnabled)
            {
                continue;
            }

            valid.Add(anchor);
        }

        return valid;
    }

    private Boss3RuneGroundAnchor FindClosestAnchorByX(List<Boss3RuneGroundAnchor> anchors, float targetX)
    {
        Boss3RuneGroundAnchor best = null;
        float bestDistance = float.MaxValue;

        foreach (Boss3RuneGroundAnchor anchor in anchors)
        {
            float distance = Mathf.Abs(anchor.Position.x - targetX);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = anchor;
            }
        }

        return best;
    }

    private void TryAddUnique(List<Boss3RuneGroundAnchor> anchors, Boss3RuneGroundAnchor candidate)
    {
        if (candidate == null || anchors.Contains(candidate))
        {
            return;
        }

        anchors.Add(candidate);
    }

    private List<GameObject> SpawnWarnings(List<Boss3RuneGroundAnchor> anchors)
    {
        List<GameObject> warnings = new();

        foreach (Boss3RuneGroundAnchor anchor in anchors)
        {
            GameObject warning = Instantiate(runeWarningPrefab, anchor.Position, Quaternion.identity);
            warnings.Add(warning);
        }

        return warnings;
    }

    private void DestroyActiveWarnings()
    {
        if (activeWarnings == null || activeWarnings.Count == 0)
        {
            return;
        }

        foreach (GameObject warning in activeWarnings)
        {
            if (warning != null)
            {
                Destroy(warning);
            }
        }

        activeWarnings.Clear();
    }

    private void SpawnExplosions(List<Boss3RuneGroundAnchor> anchors)
    {
        foreach (Boss3RuneGroundAnchor anchor in anchors)
        {
            GameObject explosion = Instantiate(runeExplosionPrefab, anchor.Position, Quaternion.identity);

            if (explosion.TryGetComponent<Boss3RuneExplosion>(out var runeExplosion))
            {
                runeExplosion.Initialize(explosionDuration);
            }
        }
    }

    public void SetPaused(bool paused)
    {
        isPaused = paused;

        if (paused)
        {
            DestroyActiveWarnings();
        }
    }

    public void CancelAttack()
    {
        isCancelled = true;
        DestroyActiveWarnings();
    }
}
