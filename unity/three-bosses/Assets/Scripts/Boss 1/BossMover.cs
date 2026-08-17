using System.Collections;
using UnityEngine;

public sealed class BossMover : MonoBehaviour
{
    public enum Segment { Right, Top, Left }

    [System.Serializable]
    public struct Side
    {
        public Transform anchor;
        public float extent;
        public float dwellSeconds;
    }

    [Header("Anchors")]
    [SerializeField] private Side right;
    [SerializeField] private Side top;
    [SerializeField] private Side left;

    [Header("Motion")]
    [SerializeField, Min(0.1f)] private float baseMoveSpeed = 6f;
    [SerializeField, Min(0f)] private float padding = 1.0f;
    [SerializeField, Min(0f)] private float speedMultiplier = 1f;
    private float dwellMultiplier = 1f;

    [Header("Hover feel")]
    [SerializeField, Min(0f)] private float bobAmplitude = 0.15f;
    [SerializeField, Min(0f)] private float bobFrequency = 2.0f;

    [Header("Facing")]
    [SerializeField] private SpriteRenderer sprite;
    [SerializeField] private bool faceRightOnLeftHalf = true;

    [Header("Sockets")]
    [SerializeField] private Transform aimPoint;
    [SerializeField] private Transform attackSpawn;
    [SerializeField] private Vector3 aimPointLeftLocal;
    [SerializeField] private Vector3 attackSpawnLeftLocal;

    private Coroutine loop;
    private bool isPaused;
    private Vector3 pausedPos;

    private float minX, maxX, minY, maxY, camMidX;

    private void Awake()
    {
        ApplyFacing();
    }

    private void LateUpdate()
    {
        if (!isPaused) return;
        transform.position = pausedPos;
    }

    public void SetPaused(bool paused)
    {
        isPaused = paused;

        if (isPaused)
            pausedPos = transform.position;
    }

    public void SetSpeedMultiplier(float multiplier)
    {
        speedMultiplier = Mathf.Max(0f, multiplier);
    }

    public void SetDwellMultiplier(float multiplier)
    {
        dwellMultiplier = Mathf.Max(0f, multiplier);
    }

    private IEnumerator WaitWhilePaused()
    {
        while (isPaused) yield return null;
    }

    public void StartPattern()
    {
        StopPattern();
        CacheCameraBounds();

        speedMultiplier = 1f;
        dwellMultiplier = 1f;

        loop = StartCoroutine(PatternLoop());
    }

    public void StopPattern()
    {
        if (loop != null) StopCoroutine(loop);
        loop = null;
    }

    private void CacheCameraBounds()
    {
        Camera cam = Camera.main;
        if (cam == null || !cam.orthographic) return;

        float halfH = cam.orthographicSize;
        float halfW = halfH * cam.aspect;

        Vector3 c = cam.transform.position;
        minX = c.x - halfW + padding;
        maxX = c.x + halfW - padding;
        minY = c.y - halfH + padding;
        maxY = c.y + halfH - padding;
        camMidX = c.x;
    }

    private IEnumerator PatternLoop()
    {
        Segment[] seq = { Segment.Right, Segment.Top, Segment.Left, Segment.Top };
        int idx = 0;

        while (true)
        {
            Segment seg = seq[idx];
            idx = (idx + 1) % seq.Length;

            yield return DoSegment(seg);
        }
    }

    private IEnumerator DoSegment(Segment seg)
    {
        Side side = seg switch
        {
            Segment.Right => right,
            Segment.Top => top,
            _ => left
        };

        Vector2 target = PickTargetOnSide(seg, side);

        if (seg == Segment.Top)
        {
            yield return TravelAxisY(ClampY(target.y));
            yield return TravelAxisX(ClampX(target.x));
        }
        else
        {
            yield return TravelAxisX(ClampX(target.x));
            yield return TravelAxisY(ClampY(target.y));
        }

        yield return Oscillate(side.dwellSeconds * dwellMultiplier);
    }

    private Vector2 PickTargetOnSide(Segment seg, Side side)
    {
        float ax = side.anchor.position.x;
        float ay = side.anchor.position.y;

        return seg switch
        {
            Segment.Right => new Vector2(ClampX(ax), ClampY(ay + Random.Range(-side.extent, side.extent))),
            Segment.Left  => new Vector2(ClampX(ax), ClampY(ay + Random.Range(-side.extent, side.extent))),
            _ => new Vector2(ClampX(camMidX), ClampY(ay))
        };
    }

    private IEnumerator Oscillate(float seconds)
    {
        float t = 0f;
        Vector3 basePos = transform.position;

        while (t < seconds)
        {
            if (isPaused) yield return WaitWhilePaused();

            float bob = Mathf.Sin(Time.time * bobFrequency) * bobAmplitude;

            Vector3 p = basePos;
            p.y += bob;

            transform.position = new Vector3(ClampX(p.x), ClampY(p.y), basePos.z);
            ApplyFacing();

            t += Time.deltaTime;
            yield return null;
        }

        transform.position = basePos;
    }

    private void ApplyFacing()
    {
        if (sprite == null || !faceRightOnLeftHalf) return;

        bool shouldFaceRight = transform.position.x <= camMidX;
        sprite.flipX = shouldFaceRight;

        ApplySocketFacing(shouldFaceRight);
    }

    private void ApplySocketFacing(bool facingRight)
    {
        if (aimPoint != null)
            aimPoint.localPosition = GetMirroredFromLeft(aimPointLeftLocal, facingRight);

        if (attackSpawn != null)
            attackSpawn.localPosition = GetMirroredFromLeft(attackSpawnLeftLocal, facingRight);
    }

    private static Vector3 GetMirroredFromLeft(Vector3 leftLocalPosition, bool facingRight)
    {
        if (!facingRight)
            return leftLocalPosition;

        return new Vector3(
            -leftLocalPosition.x,
            leftLocalPosition.y,
            leftLocalPosition.z
        );
    }

    private IEnumerator TravelAxisX(float x)
    {
        while (true)
        {
            if (isPaused) yield return WaitWhilePaused();

            Vector3 p = transform.position;
            float nx = Mathf.MoveTowards(p.x, x, baseMoveSpeed * speedMultiplier * Time.deltaTime);
            transform.position = new Vector3(nx, p.y, p.z);
            ApplyFacing();

            if (Mathf.Abs(nx - x) < 0.02f) yield break;

            yield return null;
        }
    }

    private IEnumerator TravelAxisY(float y)
    {
        while (true)
        {
            if (isPaused) yield return WaitWhilePaused();

            Vector3 p = transform.position;
            float ny = Mathf.MoveTowards(p.y, y, baseMoveSpeed * speedMultiplier * Time.deltaTime);
            transform.position = new Vector3(p.x, ny, p.z);
            ApplyFacing();

            if (Mathf.Abs(ny - y) < 0.02f) yield break;

            yield return null;
        }
    }

    private float ClampX(float x) => Mathf.Clamp(x, minX, maxX);
    private float ClampY(float y) => Mathf.Clamp(y, minY, maxY);

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying) return;

        if (aimPoint != null)
            aimPoint.localPosition = aimPointLeftLocal;

        if (attackSpawn != null)
            attackSpawn.localPosition = attackSpawnLeftLocal;
    }
#endif
}
