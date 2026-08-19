using System;

public static class RunUiFormatter
{
    public static string FormatTime(double elapsedSeconds)
    {
        double safeSeconds = double.IsFinite(elapsedSeconds)
            ? Math.Max(0d, elapsedSeconds)
            : 0d;

        int minutes = (int)(safeSeconds / 60d);
        double seconds = safeSeconds - minutes * 60d;
        return $"{minutes:00}:{seconds:00.000}";
    }
}
