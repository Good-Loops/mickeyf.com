using System;

namespace ThreeBosses.Run
{
    public static class RunRankCalculator
    {
        public static string Calculate(double elapsedSeconds)
        {
            return CalculateFromMilliseconds(
                RunScoreCalculator.CanonicalizeCompletionTimeMilliseconds(elapsedSeconds));
        }

        public static string CalculateFromMilliseconds(int completionTimeMilliseconds)
        {
            if (completionTimeMilliseconds < 1 ||
                completionTimeMilliseconds > RunScoreCalculator.MaximumCompletionTimeMilliseconds)
            {
                throw new ArgumentOutOfRangeException(nameof(completionTimeMilliseconds));
            }

            if (completionTimeMilliseconds < 60000) return "S";
            if (completionTimeMilliseconds <= 80000) return "A";
            if (completionTimeMilliseconds <= 100000) return "B";
            if (completionTimeMilliseconds <= 120000) return "C";
            return "D";
        }
    }
}
