using System;

namespace ThreeBosses.Run
{
    public static class RunScoreCalculator
    {
        public const double BasePoints = 100000d;

        public static int Calculate(double elapsedSeconds)
        {
            if (elapsedSeconds <= 0d || double.IsNaN(elapsedSeconds) || double.IsInfinity(elapsedSeconds))
                throw new ArgumentOutOfRangeException(nameof(elapsedSeconds));

            double rawScore = Math.Round(BasePoints / elapsedSeconds, MidpointRounding.AwayFromZero);
            return (int)Math.Max(1d, Math.Min(int.MaxValue, rawScore));
        }
    }
}
