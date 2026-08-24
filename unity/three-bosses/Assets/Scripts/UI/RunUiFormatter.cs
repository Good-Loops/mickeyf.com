using System;
using System.Globalization;

public static class RunUiFormatter
{
    public static string FormatTime(double elapsedSeconds)
    {
        double safeSeconds = double.IsFinite(elapsedSeconds)
            ? Math.Max(0d, elapsedSeconds)
            : 0d;
        double roundedMilliseconds = Math.Round(
            safeSeconds * 1000d,
            MidpointRounding.AwayFromZero);

        if (!double.IsFinite(roundedMilliseconds) || roundedMilliseconds > long.MaxValue)
            roundedMilliseconds = long.MaxValue;

        long totalMilliseconds = (long)roundedMilliseconds;
        long minutes = totalMilliseconds / 60000L;
        long seconds = totalMilliseconds / 1000L % 60L;
        long milliseconds = totalMilliseconds % 1000L;

        return string.Format(
            CultureInfo.InvariantCulture,
            "{0:00}:{1:00}.{2:000}",
            minutes,
            seconds,
            milliseconds);
    }
}
