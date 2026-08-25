using System;

namespace ThreeBosses.Run
{
    /// <summary>
    /// Exposes a monotonic timeline that excludes every explicitly paused interval.
    /// Browser visibility can therefore freeze run timing without coupling RunSession
    /// to Unity or the WebGL host.
    /// </summary>
    public sealed class PausableMonotonicClock : IMonotonicClock
    {
        private readonly IMonotonicClock source;

        private double excludedSeconds;
        private double pausedAtSourceSeconds;

        public PausableMonotonicClock(IMonotonicClock source)
        {
            this.source = source ?? throw new ArgumentNullException(nameof(source));
        }

        public bool IsPaused { get; private set; }

        public double NowSeconds
        {
            get
            {
                double sourceSeconds = IsPaused
                    ? pausedAtSourceSeconds
                    : source.NowSeconds;
                return sourceSeconds - excludedSeconds;
            }
        }

        public bool Pause()
        {
            if (IsPaused)
                return false;

            pausedAtSourceSeconds = source.NowSeconds;
            IsPaused = true;
            return true;
        }

        public bool Resume()
        {
            if (!IsPaused)
                return false;

            excludedSeconds += Math.Max(0d, source.NowSeconds - pausedAtSourceSeconds);
            IsPaused = false;
            return true;
        }
    }
}
