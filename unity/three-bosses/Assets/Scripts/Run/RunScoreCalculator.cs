using System;

namespace ThreeBosses.Run
{
    public static class RunScoreCalculator
    {
        public const int MinimumCompletionTimeMilliseconds = 10000;
        public const int MaximumCompletionTimeMilliseconds = 86400000;
        public const long ScoreNumerator = 10000000000L;

        public static int Calculate(double elapsedSeconds)
        {
            return CalculateFromMilliseconds(CanonicalizeCompletionTimeMilliseconds(elapsedSeconds));
        }

        public static int CanonicalizeCompletionTimeMilliseconds(double elapsedSeconds)
        {
            if (elapsedSeconds <= 0d || double.IsNaN(elapsedSeconds) || double.IsInfinity(elapsedSeconds))
                throw new ArgumentOutOfRangeException(nameof(elapsedSeconds));

            double roundedMilliseconds = Math.Round(
                elapsedSeconds * 1000d,
                MidpointRounding.AwayFromZero);
            if (roundedMilliseconds < MinimumCompletionTimeMilliseconds ||
                roundedMilliseconds > MaximumCompletionTimeMilliseconds)
                throw new ArgumentOutOfRangeException(nameof(elapsedSeconds));

            return (int)roundedMilliseconds;
        }

        public static int CalculateFromMilliseconds(int completionTimeMilliseconds)
        {
            if (completionTimeMilliseconds < MinimumCompletionTimeMilliseconds ||
                completionTimeMilliseconds > MaximumCompletionTimeMilliseconds)
            {
                throw new ArgumentOutOfRangeException(nameof(completionTimeMilliseconds));
            }

            double rawScore = Math.Round(
                (double)ScoreNumerator / completionTimeMilliseconds,
                MidpointRounding.AwayFromZero);
            return (int)Math.Max(1d, Math.Min(int.MaxValue, rawScore));
        }
    }
}
